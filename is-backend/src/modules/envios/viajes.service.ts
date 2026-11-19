import {
  BadRequestException,
  ConflictException,
  Injectable,
  Optional,
} from '@nestjs/common';
import { AsignacionService } from '../asignacion/asignacion.service';
import { DepositoRepository } from './deposito.repository';
import { inicioDelDia } from './domain/dia';
import { obtenerEtapaDeposito } from './domain/deposito';
import { esTransicionValida, siguienteEstado } from './domain/estado-envio';
import { AvanzarViajeDto } from './dto/avanzar-viaje.dto';
import { ConfirmarDevolucionDto } from './dto/confirmar-devolucion.dto';
import { ReportarIncidenteDto } from './dto/reportar-incidente.dto';
import { ReportarNovedadDto } from './dto/reportar-novedad.dto';
import { EnviosRepository } from './envios.repository';

const punto = (lat: number | null, lon: number | null) =>
  lat !== null && lon !== null ? { lat, lon } : null;

type ExigenciasEntrega = {
  requiereDni: boolean;
  requiereFoto: boolean;
  destinatarioDni: string | null;
};

// Viaje activo del repartidor logueado (E-2): verlo y avanzarlo un paso por vez.
@Injectable()
export class ViajesService {
  constructor(
    private readonly enviosRepository: EnviosRepository,
    private readonly asignacionService: AsignacionService,
    @Optional() private readonly depositoRepository?: DepositoRepository,
  ) {}

  async obtenerViajeActual(repartidorId: number) {
    const envio =
      await this.enviosRepository.buscarViajeActivoPorRepartidor(repartidorId);
    if (!envio) {
      // HU39: Si no tiene un viaje de entrega común, verificamos si tiene asignada una
      // devolución hacia el comercio de origen ("En devolución").
      const devolucion =
        await this.depositoRepository?.buscarEnvioEnDevolucionPorRepartidor(
          repartidorId,
        );
      if (
        devolucion &&
        obtenerEtapaDeposito(devolucion.estado, devolucion.eventos) ===
          'EN_DEVOLUCION'
      ) {
        return {
          viaje: {
            envioId: devolucion.id,
            codigoSeguimiento: devolucion.codigoSeguimiento,
            estado: devolucion.estado,
            siguienteEstado: null,
            esDevolucion: true,
            comercio: {
              nombre: devolucion.comercio.nombre,
              telefono: '',
            },
            origenDireccion: 'Depósito central',
            destinoDireccion: devolucion.comercio.direccion,
            origen: null,
            destino: punto(devolucion.origenLat, devolucion.origenLon),
            destinatario: {
              nombre: devolucion.comercio.nombre,
              apellido: null,
              telefono: null,
            },
            observaciones: 'Devolución de paquete al comercio de origen',
            requiereFoto: true,
            requiereDni: false,
            aviso: null,
          },
        };
      }
      const avisoCancelacion =
        await this.enviosRepository.buscarAvisoCancelacionPorRepartidor(
          repartidorId,
        );
      return avisoCancelacion
        ? { viaje: null, avisoCancelacion }
        : { viaje: null };
    }

    // Si el operario cambió la dirección con el viaje en curso (HU 31), se le avisa.
    const aviso =
      envio.eventos.find(
        (e) => e.detalle === 'La dirección de entrega fue modificada',
      )?.detalle ?? null;

    // Sin el DNI del destinatario: el repartidor no lo necesita (la evidencia es E-4).
    return {
      viaje: {
        envioId: envio.id,
        codigoSeguimiento: envio.codigoSeguimiento,
        estado: envio.estado,
        siguienteEstado: siguienteEstado(envio.estado),
        comercio: envio.comercio,
        origenDireccion: envio.origenDireccion,
        destinoDireccion: envio.destinoDireccion,
        // Para el mapa del repartidor: null si la dirección no se ubicó al cargar el envío.
        origen: punto(envio.origenLat, envio.origenLon),
        destino: punto(envio.destinoLat, envio.destinoLon),
        destinatario: {
          nombre: envio.destinatarioNombre,
          apellido: envio.destinatarioApellido,
          telefono: envio.destinatarioTelefono,
        },
        observaciones: envio.observaciones,
        requiereFoto: envio.requiereFoto,
        requiereDni: envio.requiereDni,
        aviso,
      },
    };
  }

  // HU 34: entregas que el repartidor completó hoy (día de Argentina), la más reciente primero.
  // Las novedades, cancelaciones y entregas de días anteriores no aparecen.
  async historialDelDia(repartidorId: number, ahora: Date = new Date()) {
    const envios =
      await this.enviosRepository.listarEntregadosDelRepartidorDesde(
        repartidorId,
        inicioDelDia(ahora),
      );

    const entregas = envios
      .map((envio) => ({
        envioId: envio.id,
        codigoSeguimiento: envio.codigoSeguimiento,
        comercio: envio.comercio.nombre,
        destinoDireccion: envio.destinoDireccion,
        entregadoEn: envio.eventos[0].creadoEn,
      }))
      .sort((a, b) => b.entregadoEn.getTime() - a.entregadoEn.getTime());

    return { entregas };
  }

  async avanzarViajeActual(
    repartidorId: number,
    evidencia: AvanzarViajeDto = {},
  ) {
    const envio =
      await this.enviosRepository.buscarViajeActivoPorRepartidor(repartidorId);
    if (!envio) {
      throw new ConflictException('No tenés ningún viaje activo');
    }

    const nuevo = siguienteEstado(envio.estado);
    if (!nuevo || !esTransicionValida(envio.estado, nuevo, 'REPARTIDOR')) {
      throw new ConflictException('El viaje no se puede avanzar desde acá');
    }

    // HU 18: la foto es de la entrega, así que solo se acepta en el paso que entrega.
    if (evidencia.foto && nuevo !== 'ENTREGADO') {
      throw new ConflictException(
        'La fotografía solo puede capturarse en el domicilio de entrega',
      );
    }

    const detalle =
      nuevo === 'ENTREGADO'
        ? this.verificarEvidencia(envio, evidencia)
        : undefined;

    const avanzado = await this.enviosRepository.avanzarViaje(
      envio.id,
      envio.estado,
      nuevo,
      repartidorId,
      detalle,
      evidencia.foto,
    );
    if (!avanzado) {
      throw new ConflictException(
        'El envío cambió mientras lo avanzabas (puede que lo hayan cancelado)',
      );
    }

    // Recién después de confirmar la entrega: el repartidor volvió a la cola y el motor
    // le puede ofrecer el siguiente envío.
    if (nuevo === 'ENTREGADO') {
      await this.asignacionService.reintentarPendientes();
    }
    return { estado: nuevo, siguienteEstado: siguienteEstado(nuevo) };
  }

  // HU39: Confirmar la devolución de un paquete en el comercio de origen.
  // Reglas:
  // 1. Exige siempre la foto de la constancia de recepción del comercio (Escenario 2).
  // 2. Cambia el envío al estado final "Devuelto al comercio", registra el evento para
  //    avisar al operario y libera al repartidor en la cola FIFO (Escenario 1).
  async confirmarDevolucionActual(
    repartidorId: number,
    dto: ConfirmarDevolucionDto = {},
  ) {
    // Escenario 2: Confirmación fallida sin constancia.
    if (!dto.foto || !dto.foto.trim()) {
      throw new BadRequestException('Falta la foto de la constancia');
    }

    if (!this.depositoRepository) {
      throw new ConflictException(
        'No tenés ninguna devolución activa para confirmar',
      );
    }

    const envio =
      await this.depositoRepository.buscarEnvioEnDevolucionPorRepartidor(
        repartidorId,
      );
    if (
      !envio ||
      obtenerEtapaDeposito(envio.estado, envio.eventos) !== 'EN_DEVOLUCION'
    ) {
      throw new ConflictException(
        'No tenés ninguna devolución activa para confirmar',
      );
    }

    await this.depositoRepository.confirmarDevolucionAlComercio(
      envio.id,
      repartidorId,
      dto.foto,
    );

    // El repartidor terminó el viaje de devolución y volvió al final de la cola FIFO.
    await this.asignacionService.reintentarPendientes();

    return {
      envioId: envio.id,
      codigoSeguimiento: envio.codigoSeguimiento,
      estado: 'DEVUELTO_AL_COMERCIO' as const,
      avisoOperario: `Devolución confirmada en ${envio.comercio.nombre}`,
    };
  }

  async reportarIncidente(repartidorId: number, dto: ReportarIncidenteDto) {
    const envio =
      await this.enviosRepository.buscarViajeActivoPorRepartidor(repartidorId);
    if (
      !envio ||
      !esTransicionValida(envio.estado, 'INTERRUMPIDO', 'REPARTIDOR')
    ) {
      throw new ConflictException(
        'No tenés un viaje activo para reportar un incidente',
      );
    }

    const paqueteRetirado =
      envio.estado === 'RETIRADO' || envio.estado === 'EN_DOMICILIO';
    const ubicacion = dto.ubicacion?.trim();
    if (paqueteRetirado && (!ubicacion || ubicacion.length < 3)) {
      throw new BadRequestException(
        'Ingresá la ubicación actual para reasignar el paquete',
      );
    }
    const interrumpido = await this.enviosRepository.reportarIncidente(
      repartidorId,
      ubicacion,
    );
    if (!interrumpido) {
      throw new ConflictException(
        'El viaje cambió mientras reportabas el incidente. Actualizá la pantalla e intentá de nuevo.',
      );
    }

    const oferta = await this.asignacionService.asignar(interrumpido.envioId);
    return {
      estado: 'INTERRUMPIDO' as const,
      estadoEnvio: oferta ? ('PENDIENTE' as const) : ('PARADO' as const),
      mensaje: oferta
        ? 'Incidente reportado. El envío se ofreció a otro repartidor.'
        : 'Incidente reportado. No hay repartidores compatibles; el envío quedó parado.',
    };
  }

  async reportarNovedad(repartidorId: number, dto: ReportarNovedadDto) {
    const envio =
      await this.enviosRepository.buscarViajeActivoPorRepartidor(repartidorId);
    if (
      !envio ||
      !esTransicionValida(envio.estado, 'CON_NOVEDAD', 'REPARTIDOR')
    ) {
      throw new ConflictException(
        'Solo podés reportar una novedad al llegar al domicilio',
      );
    }

    const registrada = await this.enviosRepository.reportarNovedad(
      repartidorId,
      dto,
    );
    if (!registrada) {
      throw new ConflictException(
        'El viaje cambió mientras reportabas la novedad. Actualizá la pantalla e intentá de nuevo.',
      );
    }

    await this.asignacionService.reintentarPendientes();
    return {
      estado: 'CON_NOVEDAD' as const,
      mensaje: 'Novedad registrada. El operario decidirá cómo continuar.',
    };
  }

  // E-4 (épica 4.3 / HU 18): no se entrega sin la evidencia que exige el comercio.
  // La comparación del DNI se hace acá y no en el front para no mandarle al celular el DNI del destinatario.
  // Devuelve el texto que queda en el historial del envío.
  private verificarEvidencia(
    envio: ExigenciasEntrega,
    evidencia: AvanzarViajeDto,
  ): string | undefined {
    const registro: string[] = [];

    if (envio.requiereDni) {
      if (!evidencia.dni) {
        throw new BadRequestException('Ingresá el DNI de quien recibe');
      }
      // Envíos cargados antes de que el alta exigiera el DNI: no hay contra qué comparar,
      // pero no pueden quedar trabados en la puerta del destinatario.
      if (!envio.destinatarioDni) {
        registro.push('DNI sin verificar (el envío no tenía DNI cargado)');
      } else if (envio.destinatarioDni.replace(/\D/g, '') !== evidencia.dni) {
        throw new BadRequestException(
          'El DNI no coincide con el del destinatario',
        );
      } else {
        registro.push('DNI verificado');
      }
    }

    // La foto tiene que venir en este mismo pedido: no alcanza con decir que se mandó.
    if (envio.requiereFoto && !evidencia.foto) {
      throw new BadRequestException(
        'Este comercio exige una foto de la entrega',
      );
    }
    if (evidencia.foto) registro.push('foto adjunta');

    return registro.length > 0
      ? `Evidencia: ${registro.join(', ')}`
      : undefined;
  }
}
