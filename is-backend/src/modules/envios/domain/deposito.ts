// ============================================================================
// DOMINIO DE DEPÓSITO Y DEVOLUCIONES (Fase 2: HU37, HU38, HU39 y HU40)
// ============================================================================
// GUÍA DE INGENIERÍA INVERSA (Para revisar con Salvador):
//
// ¿Por qué existe este archivo?
// En `schema.prisma` todavía no se agregaron al enum `EstadoEnvio` los estados de
// logística inversa (`A_DEVOLVER`, `EN_CUSTODIA`, `EN_DEVOLUCION`, `DEVUELTO_AL_COMERCIO`).
// Para no tocar `schema.prisma` y evitar choques de migraciones, concentramos acá toda
// la lógica de estados del depósito de forma desacoplada:
//
// 1. HOY (sin tocar `schema.prisma`):
//    Seguimos el mismo patrón que Salvador usó en G-1 (`repartidores.repository.ts`):
//    usamos la tabla `EventoEnvio` con `tipo = 'DEVOLUCION'` y distinguimos la etapa
//    exacta mediante el texto de `detalle` (`'En custodia'`, `'En devolución'`,
//    `'Devuelto al comercio'`).
//    Además, como `DetalleEnvioPage.tsx` muestra `entrada.detalle` cuando `estadoNuevo`
//    es `null`, en el historial del envío ya se ve exactamente "En custodia" con fecha,
//    hora y nombre del operario (HU37 Escenario 4).
//
// 2. MAÑANA (cuando agreguen los estados a `schema.prisma` con Salvador):
//    Las funciones de este archivo YA chequean primero `envio.estado` como texto
//    (`'EN_CUSTODIA'`, `'EN_DEVOLUCION'`, `'DEVUELTO_AL_COMERCIO'`) y usan los eventos
//    como respaldo. Por lo tanto, al agregar los valores al enum `EstadoEnvio` en
//    `schema.prisma`, este módulo sigue funcionando sin romperse.
// ============================================================================

import type { TipoEvento } from '../../../generated/prisma/client';

// Textos exactos que se guardan en `EventoEnvio.detalle` y que ve el operario en el historial.
export const DETALLE_EN_CUSTODIA = 'En custodia';
export const DETALLE_EN_DEVOLUCION = 'En devolución';
export const DETALLE_DEVUELTO_AL_COMERCIO = 'Devuelto al comercio';

// Nombres de los estados cuando se sumen al enum `EstadoEnvio` en `schema.prisma`.
export const ESTADO_FUTURO_A_DEVOLVER = 'A_DEVOLVER';
export const ESTADO_FUTURO_EN_CUSTODIA = 'EN_CUSTODIA';
export const ESTADO_FUTURO_EN_DEVOLUCION = 'EN_DEVOLUCION';
export const ESTADO_FUTURO_DEVUELTO_AL_COMERCIO = 'DEVUELTO_AL_COMERCIO';

// HU40: La alerta de paquete demorado se activa al cumplirse 24 horas exactas o más
// desde el reingreso del paquete al depósito.
export const UMBRAL_ALERTA_CUSTODIA_HORAS = 24;

export type EtapaDeposito =
  'EN_CUSTODIA' | 'EN_DEVOLUCION' | 'DEVUELTO_AL_COMERCIO';

export interface EventoDepositoMinimo {
  tipo: TipoEvento;
  estadoNuevo?: string | null;
  detalle: string | null;
  creadoEn: Date;
}

/**
 * Determina en qué etapa del circuito de depósito/devolución está un envío.
 * - Primero revisa `estadoActual` por si `schema.prisma` ya tiene los nuevos `EstadoEnvio`.
 * - Si no, inspecciona en orden cronológico los eventos del envío buscando el último
 *   hito de custodia/devolución (`En custodia` -> `En devolución` -> `Devuelto al comercio`).
 */
export function obtenerEtapaDeposito(
  estadoActual: string,
  eventos: readonly EventoDepositoMinimo[],
): EtapaDeposito | null {
  if (estadoActual === ESTADO_FUTURO_DEVUELTO_AL_COMERCIO) {
    return 'DEVUELTO_AL_COMERCIO';
  }
  if (estadoActual === ESTADO_FUTURO_EN_DEVOLUCION) {
    return 'EN_DEVOLUCION';
  }
  if (estadoActual === ESTADO_FUTURO_EN_CUSTODIA) {
    return 'EN_CUSTODIA';
  }

  let etapa: EtapaDeposito | null = null;
  for (const evento of eventos) {
    if (
      evento.estadoNuevo === ESTADO_FUTURO_DEVUELTO_AL_COMERCIO ||
      evento.detalle === DETALLE_DEVUELTO_AL_COMERCIO
    ) {
      etapa = 'DEVUELTO_AL_COMERCIO';
    } else if (
      evento.estadoNuevo === ESTADO_FUTURO_EN_DEVOLUCION ||
      evento.detalle === DETALLE_EN_DEVOLUCION
    ) {
      etapa = 'EN_DEVOLUCION';
    } else if (
      evento.estadoNuevo === ESTADO_FUTURO_EN_CUSTODIA ||
      evento.detalle === DETALLE_EN_CUSTODIA
    ) {
      etapa = 'EN_CUSTODIA';
    }
  }

  return etapa;
}

/**
 * Devuelve la fecha y hora en que el paquete ingresó por última vez a "En custodia" (HU37 / HU40).
 */
export function obtenerFechaReingresoCustodia(
  eventos: readonly EventoDepositoMinimo[],
): Date | null {
  let fecha: Date | null = null;
  for (const evento of eventos) {
    if (
      evento.estadoNuevo === ESTADO_FUTURO_EN_CUSTODIA ||
      evento.detalle === DETALLE_EN_CUSTODIA
    ) {
      fecha = evento.creadoEn;
    }
  }
  return fecha;
}

/**
 * Calcula las horas enteras transcurridas desde que el paquete reingresó a custodia (HU40).
 */
export function calcularHorasEnCustodia(
  fechaReingreso: Date,
  ahora: Date = new Date(),
): number {
  const diferenciaMs = ahora.getTime() - fechaReingreso.getTime();
  return Math.max(0, Math.floor(diferenciaMs / (1000 * 60 * 60)));
}

/**
 * HU40: Evalúa si un paquete debe aparecer en la sección "Devoluciones pendientes" con alerta.
 * Reglas:
 * 1. Debe estar actualmente en `EN_CUSTODIA` (si ya pasó a `EN_DEVOLUCION`, la alerta desaparece: Escenario 3).
 * 2. Debe llevar 24 horas o más (`>= 24`) desde su reingreso (Escenarios 1, 2 y 4).
 */
export function requiereAlertaDemoraCustodia(
  etapa: EtapaDeposito | null,
  fechaReingreso: Date | null,
  ahora: Date = new Date(),
): boolean {
  if (etapa !== 'EN_CUSTODIA' || !fechaReingreso) {
    return false;
  }
  return (
    calcularHorasEnCustodia(fechaReingreso, ahora) >=
    UMBRAL_ALERTA_CUSTODIA_HORAS
  );
}

/**
 * HU39 (Escenario 3): Verifica si el envío ya finalizó su ciclo como "Devuelto al comercio".
 * Cuando un envío está devuelto al comercio, el operario no puede cancelarlo y recibe
 * el mensaje "El envío ya finalizó su ciclo".
 */
export function esEnvioDevueltoAlComercio(
  estadoActual: string,
  eventos: readonly EventoDepositoMinimo[] = [],
): boolean {
  return obtenerEtapaDeposito(estadoActual, eventos) === 'DEVUELTO_AL_COMERCIO';
}
