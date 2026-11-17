import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AsignacionService } from '../asignacion/asignacion.service';
import { ComerciosService } from '../comercios/comercios.service';
import { DepositoRepository } from './deposito.repository';
import {
  ESTADO_FUTURO_A_DEVOLVER,
  calcularHorasEnCustodia,
  obtenerEtapaDeposito,
  obtenerFechaReingresoCustodia,
  requiereAlertaDemoraCustodia,
} from './domain/deposito';
import type { CrearOrdenDevolucionDto } from './dto/crear-orden-devolucion.dto';
import type { ReingresoDepositoDto } from './dto/reingreso-deposito.dto';

// ============================================================================
// SERVICE DE DEPÓSITO Y DEVOLUCIONES (HU37, HU38 y HU40)
// ============================================================================
// Contiene todas las reglas de negocio del depósito sin conocer HTTP ni SQL.
//
// GUÍA DE INGENIERÍA INVERSA (Para revisar con Salvador):
// - HU37 (`registrarReingreso`): valida existencia del código, pertenencia a la
//   jornada/rendición del repartidor y registra el ingreso a "En custodia".
// - HU40 (`listarDevolucionesPendientesConAlerta`): filtra los paquetes que siguen
//   "En custodia" (sin orden de devolución) y llevan >= 24 horas desde el reingreso.
// - HU38 (`listarPaquetesEnCustodiaPorComercio` y `crearOrdenDevolucion`): ofrece solo
//   los paquetes "En custodia" que aún no están en otra orden, los pasa a "En devolución"
//   y los envía a `AsignacionService.asignar(...)`.
// ============================================================================
@Injectable()
export class DepositoService {
  private readonly logger = new Logger(DepositoService.name);

  constructor(
    private readonly depositoRepository: DepositoRepository,
    private readonly comerciosService: ComerciosService,
    private readonly asignacionService: AsignacionService,
  ) {}

  // HU37: Registrar el reingreso de un paquete no entregado al depósito.
  async registrarReingreso(dto: ReingresoDepositoDto, operarioId: number) {
    const envio = await this.depositoRepository.buscarPorCodigo(
      dto.codigoSeguimiento,
    );

    // Escenario 3: Reingreso con código inexistente.
    if (!envio) {
      throw new NotFoundException('El código no corresponde a ningún envío');
    }

    // Escenario 2: Reingreso fallido por paquete de otro repartidor o que no está en su rendición.
    // Un paquete pertenece a la rendición del repartidor si:
    // 1. Tiene asignado ese `repartidorId`.
    // 2. Está pendiente de devolver en la base: sea con el futuro estado `A_DEVOLVER` (dev3)
    //    o con la regla actual de G-1 (`CANCELADO` habiendo pasado por `RETIRADO`, o `CON_NOVEDAD`).
    // 3. Todavía no fue reingresado a custodia.
    const etapaActual = obtenerEtapaDeposito(envio.estado, envio.eventos);
    const fueRetirado = envio.eventos.some(
      (evento) => evento.estadoNuevo === 'RETIRADO',
    );
    const esDevolvibleEnRendicion =
      (envio.estado as string) === ESTADO_FUTURO_A_DEVOLVER ||
      (envio.estado as string) === 'CON_NOVEDAD' ||
      (envio.estado === 'CANCELADO' && fueRetirado);

    if (
      envio.repartidorId !== dto.repartidorId ||
      !esDevolvibleEnRendicion ||
      etapaActual !== null
    ) {
      throw new ConflictException(
        'El paquete no pertenece a la jornada de este repartidor',
      );
    }

    // Escenario 1 y 4: Cambia el envío a "En custodia", lo quita de la rendición del repartidor
    // y deja registrado el evento "En custodia" con fecha, hora y el nombre del operario.
    const { fechaReingreso, operarioNombre } =
      await this.depositoRepository.registrarReingresoCustodia(
        envio.id,
        operarioId,
      );

    return {
      envioId: envio.id,
      codigoSeguimiento: envio.codigoSeguimiento,
      estado: 'EN_CUSTODIA' as const,
      comercio: envio.comercio,
      fechaReingreso,
      operarioNombre,
    };
  }

  // HU40: Listar paquetes con 24 horas o más en custodia sin orden de devolución
  // para la sección "Devoluciones pendientes" del panel del operario.
  async listarDevolucionesPendientesConAlerta(ahora: Date = new Date()) {
    const envios =
      await this.depositoRepository.listarEnviosEnCircuitoDeposito();

    const alertas = [];
    for (const envio of envios) {
      const etapa = obtenerEtapaDeposito(envio.estado, envio.eventos);
      const fechaReingreso = obtenerFechaReingresoCustodia(envio.eventos);

      if (
        requiereAlertaDemoraCustodia(etapa, fechaReingreso, ahora) &&
        fechaReingreso
      ) {
        alertas.push({
          envioId: envio.id,
          codigoSeguimiento: envio.codigoSeguimiento,
          comercio: envio.comercio,
          fechaReingreso,
          horasEnCustodia: calcularHorasEnCustodia(fechaReingreso, ahora),
        });
      }
    }

    // Los más demorados primero.
    return alertas.sort((a, b) => b.horasEnCustodia - a.horasEnCustodia);
  }

  // HU38: Obtener los paquetes actualmente "En custodia" de un comercio que todavía
  // NO fueron incluidos en otra orden de devolución (Escenario 3).
  // Si el comercio no tiene paquetes en custodia disponibles, lanza el mensaje del Escenario 2.
  async listarPaquetesEnCustodiaPorComercio(
    comercioId: number,
    ahora: Date = new Date(),
  ) {
    const comercio = await this.comerciosService.obtenerPorId(comercioId);
    const envios =
      await this.depositoRepository.listarEnviosEnCircuitoDeposito(comercioId);

    // Escenario 3: Solo se ofrecen los que siguen en `EN_CUSTODIA` (los que ya pasaron a
    // `EN_DEVOLUCION` en otra orden quedan excluidos).
    const disponibles = envios
      .filter(
        (envio) =>
          obtenerEtapaDeposito(envio.estado, envio.eventos) === 'EN_CUSTODIA',
      )
      .map((envio) => {
        const fechaReingreso = obtenerFechaReingresoCustodia(envio.eventos);
        return {
          envioId: envio.id,
          codigoSeguimiento: envio.codigoSeguimiento,
          destinoOriginal: envio.destinoDireccion,
          tamanio: envio.tamanio,
          fechaReingreso,
          horasEnCustodia: fechaReingreso
            ? calcularHorasEnCustodia(fechaReingreso, ahora)
            : 0,
        };
      });

    // Escenario 2: Comercio sin paquetes en custodia.
    if (disponibles.length === 0) {
      throw new BadRequestException(
        'No hay paquetes en custodia para este comercio',
      );
    }

    return {
      comercio: {
        id: comercio.id,
        nombre: comercio.nombre,
        direccion: comercio.direccion,
      },
      paquetes: disponibles,
    };
  }

  // HU38: Agrupar por comercio los paquetes en custodia seleccionados, pasarlos a
  // "En devolución" y enviar la orden a la asignación automática como un viaje más.
  async crearOrdenDevolucion(dto: CrearOrdenDevolucionDto, operarioId: number) {
    const { comercio, paquetes } =
      await this.listarPaquetesEnCustodiaPorComercio(dto.comercioId);

    const idsDisponibles = new Set(paquetes.map((paquete) => paquete.envioId));
    const invalidos = dto.envioIds.filter((id) => !idsDisponibles.has(id));
    if (invalidos.length > 0) {
      throw new ConflictException(
        'Uno o más paquetes seleccionados no están en custodia para este comercio o ya fueron incluidos en otra orden',
      );
    }

    const creadaEn = await this.depositoRepository.crearOrdenDevolucion(
      dto.envioIds,
      operarioId,
    );

    // La orden entra a la asignación automática como un viaje más (Regla 2 de HU38).
    // Se dispara el motor para cada paquete de la orden (o para el viaje de la orden).
    for (const envioId of dto.envioIds) {
      try {
        await this.asignacionService.asignar(envioId);
      } catch (error) {
        this.logger.error(
          `No se pudo asignar automáticamente la devolución del envío ${envioId}`,
          error,
        );
      }
    }

    const paquetesIncluidos = paquetes.filter((p) =>
      dto.envioIds.includes(p.envioId),
    );

    return {
      comercio,
      estado: 'EN_DEVOLUCION' as const,
      creadaEn,
      cantidadPaquetes: paquetesIncluidos.length,
      paquetes: paquetesIncluidos,
    };
  }
}
