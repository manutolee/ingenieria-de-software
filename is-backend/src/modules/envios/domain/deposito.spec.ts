import {
  DETALLE_DEVUELTO_AL_COMERCIO,
  DETALLE_EN_CUSTODIA,
  DETALLE_EN_DEVOLUCION,
  calcularHorasEnCustodia,
  esEnvioDevueltoAlComercio,
  obtenerEtapaDeposito,
  obtenerFechaReingresoCustodia,
  requiereAlertaDemoraCustodia,
} from './deposito';

describe('Dominio de depósito y devoluciones (HU37 a HU40)', () => {
  const AHORA = new Date('2026-11-17T18:00:00.000Z');
  const HACE_25_H = new Date(AHORA.getTime() - 25 * 60 * 60 * 1000);
  const HACE_24_H = new Date(AHORA.getTime() - 24 * 60 * 60 * 1000);
  const HACE_10_H = new Date(AHORA.getTime() - 10 * 60 * 60 * 1000);

  describe('obtenerEtapaDeposito y obtenerFechaReingresoCustodia', () => {
    it('detecta cuando el paquete está En custodia por su evento de reingreso (HU37)', () => {
      const eventos = [
        {
          tipo: 'DEVOLUCION' as const,
          detalle: DETALLE_EN_CUSTODIA,
          creadoEn: HACE_25_H,
        },
      ];

      expect(obtenerEtapaDeposito('CANCELADO', eventos)).toBe('EN_CUSTODIA');
      expect(obtenerFechaReingresoCustodia(eventos)).toEqual(HACE_25_H);
    });

    it('avanza la etapa a En devolución cuando se incluye en una orden (HU38)', () => {
      const eventos = [
        {
          tipo: 'DEVOLUCION' as const,
          detalle: DETALLE_EN_CUSTODIA,
          creadoEn: HACE_25_H,
        },
        {
          tipo: 'DEVOLUCION' as const,
          detalle: DETALLE_EN_DEVOLUCION,
          creadoEn: HACE_10_H,
        },
      ];

      expect(obtenerEtapaDeposito('CANCELADO', eventos)).toBe('EN_DEVOLUCION');
    });

    it('detecta el estado final Devuelto al comercio (HU39)', () => {
      const eventos = [
        {
          tipo: 'DEVOLUCION' as const,
          detalle: DETALLE_EN_CUSTODIA,
          creadoEn: HACE_25_H,
        },
        {
          tipo: 'DEVOLUCION' as const,
          detalle: DETALLE_EN_DEVOLUCION,
          creadoEn: HACE_10_H,
        },
        {
          tipo: 'DEVOLUCION' as const,
          detalle: DETALLE_DEVUELTO_AL_COMERCIO,
          creadoEn: AHORA,
        },
      ];

      expect(obtenerEtapaDeposito('CANCELADO', eventos)).toBe(
        'DEVUELTO_AL_COMERCIO',
      );
      expect(esEnvioDevueltoAlComercio('CANCELADO', eventos)).toBe(true);
      expect(esEnvioDevueltoAlComercio('DEVUELTO_AL_COMERCIO', [])).toBe(true);
    });
  });

  describe('requiereAlertaDemoraCustodia (HU40)', () => {
    it('Escenario 1: activa la alerta para un paquete con 25 horas en custodia sin orden de devolución', () => {
      expect(calcularHorasEnCustodia(HACE_25_H, AHORA)).toBe(25);
      expect(
        requiereAlertaDemoraCustodia('EN_CUSTODIA', HACE_25_H, AHORA),
      ).toBe(true);
    });

    it('Escenario 2: no activa la alerta para un paquete que reingresó hace 10 horas', () => {
      expect(calcularHorasEnCustodia(HACE_10_H, AHORA)).toBe(10);
      expect(
        requiereAlertaDemoraCustodia('EN_CUSTODIA', HACE_10_H, AHORA),
      ).toBe(false);
    });

    it('Escenario 3: desactiva la alerta cuando el paquete se incluye en una orden de devolución', () => {
      expect(
        requiereAlertaDemoraCustodia('EN_DEVOLUCION', HACE_25_H, AHORA),
      ).toBe(false);
    });

    it('Escenario 4: activa la alerta cuando el paquete cumple exactamente 24 horas en custodia', () => {
      expect(calcularHorasEnCustodia(HACE_24_H, AHORA)).toBe(24);
      expect(
        requiereAlertaDemoraCustodia('EN_CUSTODIA', HACE_24_H, AHORA),
      ).toBe(true);
    });
  });
});
