import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import {
  DETALLE_DEVUELTO_AL_COMERCIO,
  DETALLE_EN_CUSTODIA,
  DETALLE_EN_DEVOLUCION,
} from './domain/deposito';

// ============================================================================
// REPOSITORY DE DEPÓSITO Y DEVOLUCIONES (HU37, HU38, HU39, HU40)
// ============================================================================
// Capa de acceso a datos con PrismaService. Sin reglas de negocio.
//
// GUÍA DE INGENIERÍA INVERSA (Para revisar con Salvador):
// Cada método que persiste un cambio de estado en el circuito de depósito
// registra su `EventoEnvio` con `tipo = 'DEVOLUCION'` y el `detalle` de la etapa
// (`'En custodia'`, `'En devolución'`, `'Devuelto al comercio'`).
// Debajo de cada escritura dejamos marcado con `// TODO(schema-F2)` el cambio
// exacto para cuando agreguen `A_DEVOLVER`, `EN_CUSTODIA`, `EN_DEVOLUCION` y
// `DEVUELTO_AL_COMERCIO` al enum `EstadoEnvio` en `schema.prisma`.
// ============================================================================
@Injectable()
export class DepositoRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Busca un envío por su código de seguimiento junto con sus eventos para validar
  // si pertenece a la jornada del repartidor y si puede reingresar a custodia (HU37).
  async buscarPorCodigo(codigoSeguimiento: string) {
    return this.prisma.envio.findUnique({
      where: { codigoSeguimiento },
      omit: { fotoUrl: true },
      include: {
        comercio: { select: { id: true, nombre: true, direccion: true } },
        eventos: { orderBy: [{ creadoEn: 'asc' }, { id: 'asc' }] },
      },
    });
  }

  // HU37: Registra el reingreso del paquete al depósito bajo custodia del operario.
  // - Al crear un evento con `tipo: 'DEVOLUCION'`, la consulta `obtenerPaquetesADevolver`
  //   de G-1 (`repartidores.repository.ts`) automáticamente quita este paquete de la
  //   rendición pendiente del repartidor (Escenario 1).
  // - Al guardar `actorTipo: 'OPERARIO'` y `actorId: operarioId`, el historial del envío
  //   muestra "En custodia" con fecha, hora y el nombre del operario (Escenario 4).
  async registrarReingresoCustodia(
    envioId: number,
    operarioId: number,
  ): Promise<{ fechaReingreso: Date; operarioNombre: string | null }> {
    return this.prisma.$transaction(async (tx) => {
      // TODO(schema-F2): Cuando Salvador agregue `EN_CUSTODIA` al enum `EstadoEnvio`:
      // await tx.envio.update({
      //   where: { id: envioId },
      //   data: { estado: 'EN_CUSTODIA' },
      // });

      const evento = await tx.eventoEnvio.create({
        data: {
          envioId,
          tipo: 'DEVOLUCION',
          // TODO(schema-F2): Pasar `estadoNuevo: 'EN_CUSTODIA'` cuando exista en el enum.
          detalle: DETALLE_EN_CUSTODIA,
          actorTipo: 'OPERARIO',
          actorId: operarioId,
        },
      });

      const operario = await tx.operario.findUnique({
        where: { id: operarioId },
        select: { nombre: true },
      });

      return {
        fechaReingreso: evento.creadoEn,
        operarioNombre: operario?.nombre ?? null,
      };
    });
  }

  // HU38 y HU40: Obtiene todos los envíos que ingresaron al circuito de depósito
  // (opcionalmente filtrados por `comercioId`), con sus eventos ordenados para que el
  // dominio determine cuáles siguen "En custodia" y cuáles llevan >= 24 h.
  async listarEnviosEnCircuitoDeposito(comercioId?: number) {
    return this.prisma.envio.findMany({
      where: {
        ...(comercioId !== undefined ? { comercioId } : {}),
        eventos: {
          some: {
            OR: [{ tipo: 'DEVOLUCION' }, { detalle: DETALLE_EN_CUSTODIA }],
          },
        },
      },
      orderBy: [{ id: 'asc' }],
      omit: { fotoUrl: true },
      include: {
        comercio: { select: { id: true, nombre: true, direccion: true } },
        eventos: { orderBy: [{ creadoEn: 'asc' }, { id: 'asc' }] },
      },
    });
  }

  // HU38: Pasa los paquetes seleccionados de un mismo comercio a "En devolución"
  // dentro de una única transacción para que entren al motor de asignación automática.
  async crearOrdenDevolucion(
    envioIds: number[],
    operarioId: number,
  ): Promise<Date> {
    return this.prisma.$transaction(async (tx) => {
      // TODO(schema-F2): Cuando Salvador agregue `EN_DEVOLUCION` (o tabla `OrdenDevolucion`)
      // en `schema.prisma`, actualizar acá el estado de los envíos:
      // await tx.envio.updateMany({
      //   where: { id: { in: envioIds } },
      //   data: { estado: 'EN_DEVOLUCION', repartidorId: null },
      // });

      const ahora = new Date();
      await tx.eventoEnvio.createMany({
        data: envioIds.map((envioId) => ({
          envioId,
          tipo: 'DEVOLUCION' as const,
          // TODO(schema-F2): Agregar `estadoAnterior: 'EN_CUSTODIA', estadoNuevo: 'EN_DEVOLUCION'`.
          detalle: DETALLE_EN_DEVOLUCION,
          actorTipo: 'OPERARIO' as const,
          actorId: operarioId,
          creadoEn: ahora,
        })),
      });

      return ahora;
    });
  }

  // HU39: Busca el envío en devolución asignado al repartidor logueado para confirmar
  // su entrega de retorno en el comercio.
  async buscarEnvioEnDevolucionPorRepartidor(repartidorId: number) {
    return this.prisma.envio.findFirst({
      where: {
        repartidorId,
        eventos: {
          some: { detalle: DETALLE_EN_DEVOLUCION },
        },
      },
      orderBy: { actualizadoEn: 'desc' },
      omit: { fotoUrl: true },
      include: {
        comercio: { select: { id: true, nombre: true, direccion: true } },
        eventos: { orderBy: [{ creadoEn: 'asc' }, { id: 'asc' }] },
      },
    });
  }

  // HU39 (Escenario 1): Registra la constancia fotográfica de recepción del comercio,
  // pasa el envío a su estado final "Devuelto al comercio", crea el evento para avisar
  // al operario y libera al repartidor al final de la cola FIFO.
  async confirmarDevolucionAlComercio(
    envioId: number,
    repartidorId: number,
    fotoUrl: string,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.envio.update({
        where: { id: envioId },
        data: {
          fotoUrl,
          // TODO(schema-F2): Cuando Salvador agregue `DEVUELTO_AL_COMERCIO` al enum `EstadoEnvio`:
          // estado: 'DEVUELTO_AL_COMERCIO',
        },
      });

      await tx.eventoEnvio.create({
        data: {
          envioId,
          tipo: 'DEVOLUCION',
          // TODO(schema-F2): Pasar `estadoNuevo: 'DEVUELTO_AL_COMERCIO'` cuando exista en el enum.
          detalle: DETALLE_DEVUELTO_AL_COMERCIO,
          actorTipo: 'REPARTIDOR',
          actorId: repartidorId,
        },
      });

      await this.liberarRepartidor(tx, repartidorId, {
        viajesConsecutivos: { increment: 1 },
      });

      return true;
    });
  }

  // Misma regla que EnviosRepository.liberarRepartidor (G-1): si el repartidor había
  // solicitado el cierre de jornada, pasa a ESPERANDO_VALIDACION_CIERRE; si no, vuelve
  // a DISPONIBLE al final de la cola FIFO.
  private async liberarRepartidor(
    tx: Prisma.TransactionClient,
    repartidorId: number,
    extra: Prisma.RepartidorUpdateManyMutationInput = {},
  ) {
    await tx.repartidor.updateMany({
      where: { id: repartidorId, estado: 'OCUPADO', cierreSolicitado: true },
      data: { estado: 'ESPERANDO_VALIDACION_CIERRE', enColaDesde: null },
    });
    await tx.repartidor.updateMany({
      where: { id: repartidorId, estado: 'OCUPADO' },
      data: { estado: 'DISPONIBLE', enColaDesde: new Date(), ...extra },
    });
  }
}
