import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configurarApp } from '../src/configurar-app';
import { PrismaService } from '../src/database/prisma.service';
import { emailUnico, vaciarBase } from './utils';

const FOTO_VALIDA = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/';

// Pruebas e2e de Depósito y Devoluciones (HU37, HU38, HU39 y HU40) contra la base real.
describe('Depósito y devoluciones (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let operarioId: number;
  let comercioId: number;

  const cookieOperario = async () =>
    `access_token=${await jwt.signAsync({ sub: operarioId, rol: 'OPERARIO' })}`;

  const cookieRepartidor = async (repartidorId: number) =>
    `access_token=${await jwt.signAsync({ sub: repartidorId, rol: 'REPARTIDOR' })}`;

  async function crearRepartidor(nombre = 'Lucas') {
    const rep = await prisma.repartidor.create({
      data: {
        nombre,
        apellido: 'Gómez',
        telefono: '2215550000',
        email: emailUnico(),
        direccion: 'Calle 1 100',
        vehiculo: 'MOTO',
        estado: 'ESPERANDO_VALIDACION_CIERRE',
        cierreSolicitado: true,
      },
    });
    return rep.id;
  }

  let secuencia = 0;
  async function crearPaqueteNoEntregado(
    repartidorId: number,
    comercio = comercioId,
  ) {
    const codigoSeguimiento = `DEP00000${++secuencia}`;
    const envio = await prisma.envio.create({
      data: {
        codigoSeguimiento,
        comercioId: comercio,
        origenDireccion: 'Calle 7 123',
        destinoDireccion: 'Calle 50 567',
        destinatarioNombre: 'Juan',
        tamanio: 'CHICO',
        vehiculoRequerido: 'MOTO',
        requiereFoto: false,
        requiereDni: false,
        estado: 'CANCELADO',
        repartidorId,
        eventos: {
          create: [
            {
              tipo: 'CAMBIO_ESTADO',
              estadoNuevo: 'RETIRADO',
              actorTipo: 'REPARTIDOR',
              actorId: repartidorId,
            },
            {
              tipo: 'CAMBIO_ESTADO',
              estadoAnterior: 'RETIRADO',
              estadoNuevo: 'CANCELADO',
              actorTipo: 'OPERARIO',
              actorId: operarioId,
            },
          ],
        },
      },
    });
    return envio;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      logger: false,
    });
    configurarApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
  });

  beforeEach(async () => {
    await vaciarBase(prisma);
    operarioId = (
      await prisma.operario.create({
        data: {
          usuario: 'admin_dep',
          nombre: 'Ana Pérez',
          passwordHash: 'hash',
        },
      })
    ).id;
    comercioId = (
      await prisma.comercio.create({
        data: {
          nombre: 'Panadería Sol',
          telefono: '221 555',
          email: 'sol@test.com',
          direccion: 'Calle 7 123',
        },
      })
    ).id;
  });

  afterAll(() => app.close());

  it('HU37: registra el reingreso a En custodia, lo quita de la rendición del repartidor y figura en el historial con el nombre del operario', async () => {
    const repartidorId = await crearRepartidor();
    const otroRepartidorId = await crearRepartidor('Mateo');
    const envio = await crearPaqueteNoEntregado(repartidorId);
    const envioDeOtro = await crearPaqueteNoEntregado(otroRepartidorId);

    // Escenario 3: código inexistente
    const inexistente = await request(app.getHttpServer())
      .post('/api/envios/deposito/reingreso')
      .set('Cookie', await cookieOperario())
      .send({ repartidorId, codigoSeguimiento: 'NOEXISTE99' });
    expect(inexistente.status).toBe(404);
    expect(inexistente.body.message).toBe(
      'El código no corresponde a ningún envío',
    );

    // Escenario 2: paquete de otro repartidor
    const ajeno = await request(app.getHttpServer())
      .post('/api/envios/deposito/reingreso')
      .set('Cookie', await cookieOperario())
      .send({
        repartidorId,
        codigoSeguimiento: envioDeOtro.codigoSeguimiento,
      });
    expect(ajeno.status).toBe(409);
    expect(ajeno.body.message).toBe(
      'El paquete no pertenece a la jornada de este repartidor',
    );

    // Escenario 1: reingreso exitoso
    const ok = await request(app.getHttpServer())
      .post('/api/envios/deposito/reingreso')
      .set('Cookie', await cookieOperario())
      .send({ repartidorId, codigoSeguimiento: envio.codigoSeguimiento });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      envioId: envio.id,
      estado: 'EN_CUSTODIA',
      operarioNombre: 'Ana Pérez',
    });

    // Verifica que se quitó de la rendición del repartidor
    const rendicion = await request(app.getHttpServer())
      .get(`/api/repartidores/${repartidorId}/rendicion`)
      .set('Cookie', await cookieOperario());
    expect(rendicion.body.paquetesADevolver).toEqual([]);

    // Escenario 4: figura "En custodia" en el historial del envío con el nombre del operario
    const detalle = await request(app.getHttpServer())
      .get(`/api/envios/${envio.id}`)
      .set('Cookie', await cookieOperario());
    expect(detalle.body.historial).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detalle: 'En custodia',
          actorTipo: 'OPERARIO',
          actorNombre: 'Ana Pérez',
        }),
      ]),
    );
  });

  it('HU38, HU39 y HU40: activa alerta >= 24 h, genera orden de devolución quitando la alerta, y confirma devolución con foto bloqueando cancelación posterior', async () => {
    const repartidorId = await crearRepartidor();
    const envio = await crearPaqueteNoEntregado(repartidorId);

    // Reingresa hace 25 horas (HU40 Escenario 1)
    const hace25Horas = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await prisma.eventoEnvio.create({
      data: {
        envioId: envio.id,
        tipo: 'DEVOLUCION',
        detalle: 'En custodia',
        actorTipo: 'OPERARIO',
        actorId: operarioId,
        creadoEn: hace25Horas,
      },
    });

    const alertasAntes = await request(app.getHttpServer())
      .get('/api/envios/deposito/alertas')
      .set('Cookie', await cookieOperario());
    expect(alertasAntes.status).toBe(200);
    expect(alertasAntes.body).toEqual([
      expect.objectContaining({
        envioId: envio.id,
        horasEnCustodia: 25,
      }),
    ]);

    // HU38: Crear orden de devolución
    const orden = await request(app.getHttpServer())
      .post('/api/envios/deposito/ordenes-devolucion')
      .set('Cookie', await cookieOperario())
      .send({ comercioId, envioIds: [envio.id] });
    expect(orden.status).toBe(201);
    expect(orden.body.estado).toBe('EN_DEVOLUCION');

    // HU40 Escenario 3: La alerta desaparece al incluir el paquete en una orden de devolución
    const alertasDespues = await request(app.getHttpServer())
      .get('/api/envios/deposito/alertas')
      .set('Cookie', await cookieOperario());
    expect(alertasDespues.body).toEqual([]);

    // HU39 Escenario 2: Confirmar devolución sin foto falla con "Falta la foto de la constancia"
    const sinFoto = await request(app.getHttpServer())
      .post('/api/repartidor/viajes/actual/confirmar-devolucion')
      .set('Cookie', await cookieRepartidor(repartidorId))
      .send({});
    expect(sinFoto.status).toBe(400);
    expect(sinFoto.body.message).toBe('Falta la foto de la constancia');

    // HU39 Escenario 1: Confirmar devolución con foto pasa a DEVUELTO_AL_COMERCIO
    const conFoto = await request(app.getHttpServer())
      .post('/api/repartidor/viajes/actual/confirmar-devolucion')
      .set('Cookie', await cookieRepartidor(repartidorId))
      .send({ foto: FOTO_VALIDA });
    expect(conFoto.status).toBe(200);
    expect(conFoto.body.estado).toBe('DEVUELTO_AL_COMERCIO');

    // HU39 Escenario 3: Intentar cancelar un envío devuelto muestra "El envío ya finalizó su ciclo"
    const cancelarDevuelto = await request(app.getHttpServer())
      .post(`/api/envios/${envio.id}/cancelar`)
      .set('Cookie', await cookieOperario());
    expect(cancelarDevuelto.status).toBe(409);
    expect(cancelarDevuelto.body.message).toBe('El envío ya finalizó su ciclo');
  });
});
