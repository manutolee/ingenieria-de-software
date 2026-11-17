import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AsignacionService } from '../asignacion/asignacion.service';
import { ComerciosService } from '../comercios/comercios.service';
import { DepositoRepository } from './deposito.repository';
import { DepositoService } from './deposito.service';
import {
  DETALLE_DEVUELTO_AL_COMERCIO,
  DETALLE_EN_CUSTODIA,
  DETALLE_EN_DEVOLUCION,
} from './domain/deposito';
import { EnviosRepository } from './envios.repository';
import { EnviosService } from './envios.service';
import { ViajesService } from './viajes.service';

const FOTO_VALIDA = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/';

describe('Depósito y devoluciones (HU37, HU38, HU39 y HU40)', () => {
  let depositoService: DepositoService;
  let viajesService: ViajesService;
  let enviosService: EnviosService;

  const depositoRepository = {
    buscarPorCodigo: jest.fn(),
    registrarReingresoCustodia: jest.fn(),
    listarEnviosEnCircuitoDeposito: jest.fn(),
    crearOrdenDevolucion: jest.fn(),
    buscarEnvioEnDevolucionPorRepartidor: jest.fn(),
    confirmarDevolucionAlComercio: jest.fn(),
  };

  const enviosRepository = {
    obtenerEstado: jest.fn(),
    cancelar: jest.fn(),
  };

  const comerciosService = {
    obtenerPorId: jest.fn(),
  };

  const asignacionService = {
    asignar: jest.fn(),
    reintentarPendientes: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    const modulo = await Test.createTestingModule({
      providers: [
        DepositoService,
        ViajesService,
        EnviosService,
        { provide: DepositoRepository, useValue: depositoRepository },
        { provide: EnviosRepository, useValue: enviosRepository },
        { provide: ComerciosService, useValue: comerciosService },
        { provide: AsignacionService, useValue: asignacionService },
      ],
    }).compile();

    depositoService = modulo.get(DepositoService);
    viajesService = modulo.get(ViajesService);
    enviosService = modulo.get(EnviosService);
  });

  // ==========================================================================
  // HU37: Registrar Reingreso de paquetes al depósito
  // ==========================================================================
  describe('HU37 · Registrar Reingreso de paquetes al depósito', () => {
    it('Escenario 1 y 4: cambia el envío a En custodia, lo quita de la rendición y registra fecha, hora y operario', async () => {
      const fechaReingreso = new Date('2026-11-17T18:00:00.000Z');
      depositoRepository.buscarPorCodigo.mockResolvedValue({
        id: 10,
        codigoSeguimiento: 'PKG1234567',
        estado: 'CANCELADO',
        repartidorId: 5,
        comercio: { id: 1, nombre: 'Panadería Sol', direccion: 'Calle 7 123' },
        eventos: [
          {
            tipo: 'CAMBIO_ESTADO',
            estadoNuevo: 'RETIRADO',
            detalle: null,
            creadoEn: new Date('2026-11-17T14:00:00.000Z'),
          },
        ],
      });
      depositoRepository.registrarReingresoCustodia.mockResolvedValue({
        fechaReingreso,
        operarioNombre: 'Ana Pérez',
      });

      const resultado = await depositoService.registrarReingreso(
        { repartidorId: 5, codigoSeguimiento: 'PKG1234567' },
        99,
      );

      expect(
        depositoRepository.registrarReingresoCustodia,
      ).toHaveBeenCalledWith(10, 99);
      expect(resultado).toEqual({
        envioId: 10,
        codigoSeguimiento: 'PKG1234567',
        estado: 'EN_CUSTODIA',
        comercio: { id: 1, nombre: 'Panadería Sol', direccion: 'Calle 7 123' },
        fechaReingreso,
        operarioNombre: 'Ana Pérez',
      });
    });

    it('Escenario 2: rechaza un paquete asignado a otro repartidor con el mensaje correspondiente', async () => {
      depositoRepository.buscarPorCodigo.mockResolvedValue({
        id: 11,
        codigoSeguimiento: 'OTRO999999',
        estado: 'CANCELADO',
        repartidorId: 8,
        comercio: { id: 1, nombre: 'Panadería Sol', direccion: 'Calle 7 123' },
        eventos: [
          {
            tipo: 'CAMBIO_ESTADO',
            estadoNuevo: 'RETIRADO',
            detalle: null,
            creadoEn: new Date(),
          },
        ],
      });

      await expect(
        depositoService.registrarReingreso(
          { repartidorId: 5, codigoSeguimiento: 'OTRO999999' },
          99,
        ),
      ).rejects.toThrow(
        new ConflictException(
          'El paquete no pertenece a la jornada de este repartidor',
        ),
      );
      expect(
        depositoRepository.registrarReingresoCustodia,
      ).not.toHaveBeenCalled();
    });

    it('Escenario 3: rechaza un código que no corresponde a ningún envío', async () => {
      depositoRepository.buscarPorCodigo.mockResolvedValue(null);

      await expect(
        depositoService.registrarReingreso(
          { repartidorId: 5, codigoSeguimiento: 'NOEXISTE00' },
          99,
        ),
      ).rejects.toThrow(
        new NotFoundException('El código no corresponde a ningún envío'),
      );
      expect(
        depositoRepository.registrarReingresoCustodia,
      ).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // HU38: Ordenar devolución al comercio
  // ==========================================================================
  describe('HU38 · Ordenar devolución al comercio', () => {
    const comercio = {
      id: 1,
      nombre: 'Panadería Sol',
      direccion: 'Calle 7 123',
      activo: true,
    };

    it('Escenario 1: genera la orden con los 3 paquetes en custodia de un mismo comercio y la envía a la asignación', async () => {
      comerciosService.obtenerPorId.mockResolvedValue(comercio);
      const fechaCustodia = new Date('2026-11-17T10:00:00.000Z');
      depositoRepository.listarEnviosEnCircuitoDeposito.mockResolvedValue([
        {
          id: 101,
          codigoSeguimiento: 'CUST000101',
          estado: 'CANCELADO',
          destinoDireccion: 'Calle 1 100',
          tamanio: 'CHICO',
          comercio,
          eventos: [
            {
              tipo: 'DEVOLUCION',
              detalle: DETALLE_EN_CUSTODIA,
              creadoEn: fechaCustodia,
            },
          ],
        },
        {
          id: 102,
          codigoSeguimiento: 'CUST000102',
          estado: 'CANCELADO',
          destinoDireccion: 'Calle 2 200',
          tamanio: 'CHICO',
          comercio,
          eventos: [
            {
              tipo: 'DEVOLUCION',
              detalle: DETALLE_EN_CUSTODIA,
              creadoEn: fechaCustodia,
            },
          ],
        },
        {
          id: 103,
          codigoSeguimiento: 'CUST000103',
          estado: 'CANCELADO',
          destinoDireccion: 'Calle 3 300',
          tamanio: 'MEDIANO',
          comercio,
          eventos: [
            {
              tipo: 'DEVOLUCION',
              detalle: DETALLE_EN_CUSTODIA,
              creadoEn: fechaCustodia,
            },
          ],
        },
      ]);
      depositoRepository.crearOrdenDevolucion.mockResolvedValue(new Date());

      const orden = await depositoService.crearOrdenDevolucion(
        { comercioId: 1, envioIds: [101, 102, 103] },
        99,
      );

      expect(depositoRepository.crearOrdenDevolucion).toHaveBeenCalledWith(
        [101, 102, 103],
        99,
      );
      expect(asignacionService.asignar).toHaveBeenCalledTimes(3);
      expect(orden.estado).toBe('EN_DEVOLUCION');
      expect(orden.cantidadPaquetes).toBe(3);
    });

    it('Escenario 2: muestra "No hay paquetes en custodia para este comercio" cuando el comercio no tiene paquetes en custodia', async () => {
      comerciosService.obtenerPorId.mockResolvedValue(comercio);
      depositoRepository.listarEnviosEnCircuitoDeposito.mockResolvedValue([]);

      await expect(
        depositoService.listarPaquetesEnCustodiaPorComercio(1),
      ).rejects.toThrow(
        new BadRequestException(
          'No hay paquetes en custodia para este comercio',
        ),
      );
    });

    it('Escenario 3: cuando 1 de los 3 paquetes ya está en otra orden de devolución, solo ofrece los 2 restantes', async () => {
      comerciosService.obtenerPorId.mockResolvedValue(comercio);
      const fecha = new Date('2026-11-17T10:00:00.000Z');
      depositoRepository.listarEnviosEnCircuitoDeposito.mockResolvedValue([
        {
          id: 201,
          codigoSeguimiento: 'CUST000201',
          estado: 'CANCELADO',
          destinoDireccion: 'Calle 1',
          tamanio: 'CHICO',
          comercio,
          eventos: [
            {
              tipo: 'DEVOLUCION',
              detalle: DETALLE_EN_CUSTODIA,
              creadoEn: fecha,
            },
            {
              tipo: 'DEVOLUCION',
              detalle: DETALLE_EN_DEVOLUCION,
              creadoEn: fecha,
            },
          ],
        },
        {
          id: 202,
          codigoSeguimiento: 'CUST000202',
          estado: 'CANCELADO',
          destinoDireccion: 'Calle 2',
          tamanio: 'CHICO',
          comercio,
          eventos: [
            {
              tipo: 'DEVOLUCION',
              detalle: DETALLE_EN_CUSTODIA,
              creadoEn: fecha,
            },
          ],
        },
        {
          id: 203,
          codigoSeguimiento: 'CUST000203',
          estado: 'CANCELADO',
          destinoDireccion: 'Calle 3',
          tamanio: 'CHICO',
          comercio,
          eventos: [
            {
              tipo: 'DEVOLUCION',
              detalle: DETALLE_EN_CUSTODIA,
              creadoEn: fecha,
            },
          ],
        },
      ]);

      const resultado =
        await depositoService.listarPaquetesEnCustodiaPorComercio(1);

      expect(resultado.paquetes.map((p) => p.envioId)).toEqual([202, 203]);
    });
  });

  // ==========================================================================
  // HU39: Confirmar devolución al comercio
  // ==========================================================================
  describe('HU39 · Confirmar devolución al comercio', () => {
    it('Escenario 1: con foto de constancia cambia el envío a Devuelto al comercio, avisa al operario y libera al repartidor', async () => {
      depositoRepository.buscarEnvioEnDevolucionPorRepartidor.mockResolvedValue(
        {
          id: 50,
          codigoSeguimiento: 'DEV0000050',
          estado: 'CANCELADO',
          comercio: {
            id: 1,
            nombre: 'Panadería Sol',
            direccion: 'Calle 7 123',
          },
          eventos: [
            {
              tipo: 'DEVOLUCION',
              detalle: DETALLE_EN_CUSTODIA,
              creadoEn: new Date(),
            },
            {
              tipo: 'DEVOLUCION',
              detalle: DETALLE_EN_DEVOLUCION,
              creadoEn: new Date(),
            },
          ],
        },
      );
      depositoRepository.confirmarDevolucionAlComercio.mockResolvedValue(true);

      const respuesta = await viajesService.confirmarDevolucionActual(5, {
        foto: FOTO_VALIDA,
      });

      expect(
        depositoRepository.confirmarDevolucionAlComercio,
      ).toHaveBeenCalledWith(50, 5, FOTO_VALIDA);
      expect(asignacionService.reintentarPendientes).toHaveBeenCalled();
      expect(respuesta).toEqual({
        envioId: 50,
        codigoSeguimiento: 'DEV0000050',
        estado: 'DEVUELTO_AL_COMERCIO',
        avisoOperario: 'Devolución confirmada en Panadería Sol',
      });
    });

    it('Escenario 2: sin foto de constancia mantiene el estado y muestra "Falta la foto de la constancia"', async () => {
      await expect(
        viajesService.confirmarDevolucionActual(5, {}),
      ).rejects.toThrow(
        new BadRequestException('Falta la foto de la constancia'),
      );
      expect(
        depositoRepository.confirmarDevolucionAlComercio,
      ).not.toHaveBeenCalled();
    });

    it('Escenario 3: si el operario intenta cancelar un envío Devuelto al comercio, mantiene el estado y muestra "El envío ya finalizó su ciclo"', async () => {
      enviosRepository.obtenerEstado.mockResolvedValue({
        id: 50,
        estado: 'CANCELADO',
        eventos: [
          {
            tipo: 'DEVOLUCION',
            estadoNuevo: null,
            detalle: DETALLE_DEVUELTO_AL_COMERCIO,
            creadoEn: new Date(),
          },
        ],
      });

      await expect(enviosService.cancelar(50, 1)).rejects.toThrow(
        new ConflictException('El envío ya finalizó su ciclo'),
      );
      expect(enviosRepository.cancelar).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // HU40: Recibir Alerta de paquetes demorados en depósito
  // ==========================================================================
  describe('HU40 · Recibir Alerta de paquetes demorados en depósito', () => {
    const AHORA = new Date('2026-11-17T18:00:00.000Z');
    const HACE_25_H = new Date(AHORA.getTime() - 25 * 60 * 60 * 1000);
    const HACE_24_H = new Date(AHORA.getTime() - 24 * 60 * 60 * 1000);
    const HACE_10_H = new Date(AHORA.getTime() - 10 * 60 * 60 * 1000);

    it('Escenarios 1, 2, 3 y 4: incluye paquetes con 25 h y 24 h exactas en custodia, excluye los de 10 h y quita los que ya tienen orden de devolución', async () => {
      const comercio = {
        id: 1,
        nombre: 'Panadería Sol',
        direccion: 'Calle 7 123',
      };
      depositoRepository.listarEnviosEnCircuitoDeposito.mockResolvedValue([
        // Escenario 1: 25 horas en custodia sin orden -> aparece con 25 h
        {
          id: 1,
          codigoSeguimiento: 'DEMORA25H',
          estado: 'CANCELADO',
          comercio,
          eventos: [
            {
              tipo: 'DEVOLUCION',
              detalle: DETALLE_EN_CUSTODIA,
              creadoEn: HACE_25_H,
            },
          ],
        },
        // Escenario 2: 10 horas en custodia -> no tiene alerta
        {
          id: 2,
          codigoSeguimiento: 'RECIEN10H',
          estado: 'CANCELADO',
          comercio,
          eventos: [
            {
              tipo: 'DEVOLUCION',
              detalle: DETALLE_EN_CUSTODIA,
              creadoEn: HACE_10_H,
            },
          ],
        },
        // Escenario 3: 25 horas pero ya incluido en una orden de devolución -> desaparece la alerta
        {
          id: 3,
          codigoSeguimiento: 'ENORDEN25',
          estado: 'CANCELADO',
          comercio,
          eventos: [
            {
              tipo: 'DEVOLUCION',
              detalle: DETALLE_EN_CUSTODIA,
              creadoEn: HACE_25_H,
            },
            {
              tipo: 'DEVOLUCION',
              detalle: DETALLE_EN_DEVOLUCION,
              creadoEn: HACE_10_H,
            },
          ],
        },
        // Escenario 4: 24 horas exactas en custodia sin orden -> aparece con 24 h
        {
          id: 4,
          codigoSeguimiento: 'EXACTO24H',
          estado: 'CANCELADO',
          comercio,
          eventos: [
            {
              tipo: 'DEVOLUCION',
              detalle: DETALLE_EN_CUSTODIA,
              creadoEn: HACE_24_H,
            },
          ],
        },
      ]);

      const alertas =
        await depositoService.listarDevolucionesPendientesConAlerta(AHORA);

      expect(alertas).toEqual([
        expect.objectContaining({
          envioId: 1,
          codigoSeguimiento: 'DEMORA25H',
          horasEnCustodia: 25,
        }),
        expect.objectContaining({
          envioId: 4,
          codigoSeguimiento: 'EXACTO24H',
          horasEnCustodia: 24,
        }),
      ]);
    });
  });
});
