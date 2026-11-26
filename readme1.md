# Sistema de Gestión y Seguimiento de Repartos

Aplicación web full-stack para la gestión integral de logística urbana y envíos de última milla, desarrollada en equipo para **Práctica de Ingeniería de Software (2026)** — Ingeniería en Computación, **UNLP** (Grupo 9).

El sistema cubre el ciclo de vida completo de un envío a través de tres áreas diferenciadas:

- **Panel del operario (web):** administración de comercios y repartidores, alta y edición de envíos, monitoreo de flota y colas FIFO, resolución manual de excepciones, custodia en depósito, órdenes de devolución y resúmenes diarios.
- **App web móvil del repartidor:** acceso rápido con PIN, gestión de jornada y disponibilidad, recepción de ofertas de viaje con temporizador de 5 minutos, avance de estados en 2 toques, captura de evidencia fotográfica, reporte de novedades/incidentes y rendición de cierre de jornada.
- **Portal público de seguimiento:** consulta sin registro para el destinatario mediante código único, con línea de tiempo, franja horaria estimada y protección de datos personales.

---

## Mi participación en el proyecto — Manuel Toledo

Trabajé de punta a punta (**backend en NestJS + Prisma/PostgreSQL, frontend en React + TypeScript + Tailwind y pruebas unitarias + end-to-end**) en tres funcionalidades clave del sistema:

### 1. Módulo de seguimiento público para destinatarios (Full-Stack)
- **API pública y seguridad ([`is-backend/src/modules/seguimiento/`](is-backend/src/modules/seguimiento/)):** implementé el endpoint público `GET /api/seguimiento/:codigo` con búsqueda indexada por código de seguimiento y límite de consultas por IP (`@Throttle`: 30 req/min) para prevenir ataques de enumeración y fuerza bruta.
- **Generación de códigos seguros ([`codigo-seguimiento.util.ts`](is-backend/src/modules/envios/codigo-seguimiento.util.ts)):** desarrollé el generador aleatorio de códigos alfanuméricos de 10 caracteres en Base32 usando `crypto.randomInt`, excluyendo caracteres visualmente ambiguos (`0`, `O`, `1`, `I`).
- **Privacidad por diseño ([`seguimiento.service.ts`](is-backend/src/modules/seguimiento/seguimiento.service.ts)):** implementé el enmascaramiento automático del nombre del destinatario (ej. `Juan P.`) y de la dirección de entrega (ocultando altura, piso y departamento) para evitar la exposición de datos personales en la consulta pública.
- **Interfaz para el destinatario ([`SeguimientoPage.tsx`](is-frontend/src/features/seguimiento/SeguimientoPage.tsx)):** desarrollé la pantalla responsive de consulta pública con visualización del estado actual, línea de tiempo del envío, manejo de errores y auto-actualización periódica cada 60 segundos.
- **Testing:** pruebas unitarias de la lógica de enmascaramiento, consulta y generación de códigos (`seguimiento.service.spec.ts`, `codigo-seguimiento.util.spec.ts`).

### 2. Custodia en depósito y devoluciones al comercio (Full-Stack — HU 37, 38, 39 y 40)
- **Backend en capas y lógica de dominio ([`deposito.controller.ts`](is-backend/src/modules/envios/deposito.controller.ts), [`deposito.service.ts`](is-backend/src/modules/envios/deposito.service.ts), [`deposito.repository.ts`](is-backend/src/modules/envios/deposito.repository.ts), [`domain/deposito.ts`](is-backend/src/modules/envios/domain/deposito.ts)):** implementé el circuito de paquetes no entregados respetando la separación `controller → service → repository` + lógica pura de dominio y validación de DTOs con `class-validator`:
  - Registro de reingreso al depósito (`POST /api/envios/deposito/reingreso`).
  - Detección y listado de alertas para paquetes con 24 horas o más en custodia sin devolución (`GET /api/envios/deposito/alertas`).
  - Consulta de paquetes en custodia por comercio y creación de órdenes de devolución agrupadas (`GET /api/envios/deposito/custodia`, `POST /api/envios/deposito/ordenes-devolucion`).
  - Integración con el flujo de viajes (`viajes.service.ts`) para confirmar devoluciones al comercio desde el rol de repartidor.
- **Frontend ([`DepositoDevolucionesSeccion.tsx`](is-frontend/src/features/operario/envios/DepositoDevolucionesSeccion.tsx), [`AprobarCierreModal.tsx`](is-frontend/src/features/operario/repartidores/AprobarCierreModal.tsx), [`ViajeActual.tsx`](is-frontend/src/features/repartidor/viaje/ViajeActual.tsx)):** vista de gestión de depósito y armado de órdenes de devolución para el operario, integración en el cierre de jornada y soporte en la pantalla móvil del repartidor.
- **Testing:** suite de pruebas unitarias de dominio y servicio (`domain/deposito.spec.ts`, `deposito.service.spec.ts`) y pruebas end-to-end contra PostgreSQL con Supertest ([`test/deposito-devoluciones.e2e-spec.ts`](is-backend/test/deposito-devoluciones.e2e-spec.ts)).

### 3. Resumen diario de envíos por comercio (Full-Stack — HU 41)
- **Backend ([`comercios.controller.ts`](is-backend/src/modules/comercios/comercios.controller.ts), [`comercios.service.ts`](is-backend/src/modules/comercios/comercios.service.ts), [`comercios.repository.ts`](is-backend/src/modules/comercios/comercios.repository.ts)):** implementé el endpoint `GET /api/comercios/:id/resumen?fecha=AAAA-MM-DD` con validación de fecha y cálculo de métricas operativas diarias por comercio.
- **Frontend ([`ComerciosPage.tsx`](is-frontend/src/features/operario/comercios/ComerciosPage.tsx)):** visualización del resumen diario dentro del panel de comercios del operario.
- **Testing:** pruebas unitarias (`comercios.service.spec.ts`) y pruebas end-to-end ([`test/resumen-comercio.e2e-spec.ts`](is-backend/test/resumen-comercio.e2e-spec.ts)).

---

## Equipo y distribución de responsabilidades

Proyecto realizado en equipo de 6 integrantes aplicando metodología iterativa (Scrum), flujo Git con ramas `feature/*` → PR con CI hacia `dev` → releases en `main`, y revisión de código entre pares:

| Integrante | Principales módulos y funcionalidades desarrolladas |
|---|---|
| **Manuel Toledo** | Seguimiento público de envíos (backend, enmascaramiento de datos, generador Base32, rate limiting y vista responsive), custodia en depósito y órdenes de devolución al comercio (HU 37–40) y resumen diario por comercio (HU 41), con tests unitarios y e2e. |
| **Salvador (`@salvaKaraka`)** | Arquitectura base y configuración (NestJS, Prisma, Docker, CI, deploy), autenticación JWT/PIN con refresh tokens rotativos y guards globales, motor de asignación FIFO con bloqueos de fila y vencimiento de ofertas, historial de envíos, franja estimada de llegada y mapas, integración general y demos. |
| **Diego Vignau** | ABM de repartidores (backend y frontend), jornada y monitoreo de flota, modificación de envíos antes del retiro, regla de 2 viajes consecutivos, cierre de jornada y rendición, captura de foto de evidencia (HU 18), disponibilidad (HU 8), panel de envíos del día (HU 4), historial de respuestas (HU 28) y perfil/cambio de PIN (HU 68). |
| **Rocío Pascual Velázquez** | ABM completo de comercios (backend y frontend), listado, detalle y alta/cancelación de envíos en el panel del operario, script de datos de prueba (`seed`), historial diario de entregas del repartidor (HU 34) y panel de excepciones con asignación manual (HU 12 y 22). |
| **Juan Manuel Soler** | Máquina de estados de envíos, reporte de novedades/problemas en domicilio (HU 23), reintento de entrega o derivación a devolución (HU 24) y cancelación de envíos antes del retiro con aviso al repartidor (HU 30). |
| **Santiago (`@SantiC006`)** | Endpoints del viaje activo para el repartidor y gestión de incidentes en ruta con rehabilitación de repartidores. |

---

## Arquitectura y aspectos técnicos destacados

- **Monolito modular en capas (`controller → service → repository`):** cada módulo de negocio encapsula su acceso a datos mediante Prisma, exponiendo únicamente su servicio hacia otros módulos. Las reglas puras viven en `domain/` sin acoplamiento a HTTP ni base de datos.
- **Motor de asignación FIFO y concurrencia:** cola de repartidores por tipo de vehículo con transacciones atómicas, bloqueos a nivel de fila y vencimiento automático de ofertas cada 5 minutos.
- **Seguridad y control de acceso:** guards globales por defecto (todo endpoint requiere sesión salvo `@Public()`), roles (`@Roles('OPERARIO' | 'REPARTIDOR')`), hash Argon2, refresh tokens rotativos en cookies `httpOnly` y rate limiting en rutas públicas.
- **Trazabilidad completa:** cada transición de estado o evento operativo registra un `EventoEnvio` para auditoría e historial.
- **Calidad y CI:** validación de DTOs con `class-validator`, linter (`oxlint`), pruebas unitarias con Jest, suite de pruebas end-to-end contra base PostgreSQL dedicada (`is_db_test`) y verificación automática en cada Pull Request mediante GitHub Actions.

---

## Stack tecnológico

| Capa | Tecnologías | Despliegue |
|---|---|---|
| **Backend (API REST)** | NestJS 12, TypeScript, Prisma 7, Argon2, JWT, `@nestjs/throttler`, `@nestjs/schedule` | Render |
| **Base de datos** | PostgreSQL 17 | Supabase |
| **Frontend (SPA)** | React 19, Vite 8, TypeScript, React Router 8, Tailwind CSS 4, Leaflet | Vercel |
| **Testing y calidad** | Jest 30, Supertest, Oxlint, Prettier, GitHub Actions (CI) | — |
| **Entorno local** | Docker Compose | — |

---

## Estructura del repositorio

```text
.
├── docs/                       Documentación funcional (entrevistas, épicas, RNF, PGP)
├── is-backend/                 API REST en NestJS
│   ├── prisma/                 schema.prisma y migraciones SQL
│   ├── src/
│   │   ├── main.ts             Arranque (prefijo /api, ValidationPipe, CORS, cookies)
│   │   ├── app.module.ts       Módulo raíz
│   │   ├── common/             Guards, decoradores de auth y utilidades compartidas
│   │   ├── config/             Validación de variables de entorno
│   │   ├── database/           PrismaService
│   │   └── modules/            Módulos de negocio:
│   │       ├── asignacion/     Motor FIFO, ofertas y vencimientos
│   │       ├── auth/           Login operario/repartidor, JWT y refresh tokens
│   │       ├── comercios/      ABM de comercios y resumen diario
│   │       ├── envios/         Envíos, viajes, máquina de estados, depósito y devoluciones
│   │       ├── excepciones/    Panel de excepciones y asignación manual
│   │       ├── mapas/          Geocodificación y cálculo de tiempos estimados
│   │       ├── repartidores/   ABM, jornada, flota, cierre/rendición e incidentes
│   │       └── seguimiento/    Tracking público y enmascaramiento de datos
│   └── test/                   Tests end-to-end (Supertest + PostgreSQL)
├── is-frontend/                SPA en React + Vite + Tailwind
│   └── src/
│       ├── router.tsx          Rutas protegidas y públicas
│       ├── features/           auth/, operario/, repartidor/, seguimiento/
│       └── shared/             Cliente HTTP, layouts, usePolling y componentes UI
├── docker-compose.yml          PostgreSQL (+ API opcional) para desarrollo local
└── .github/workflows/          Pipeline de CI (lint, tests y build)
```

---

## Cómo levantar el proyecto localmente

### Requisitos
- [Node.js 24](https://nodejs.org/) (`npm`)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- Git

### Opción 1: Base + API en Docker y frontend en modo desarrollo

```bash
docker compose up -d --build      # PostgreSQL en :5433 y API en :3000

cd is-frontend
npm install
npm run dev                       # http://localhost:5173
```

Para crear usuarios de prueba locales (una sola vez):

```bash
docker compose exec api node dist/scripts/crear-usuarios-prueba
```

### Opción 2: Solo base en Docker, API y frontend en local

```bash
docker compose up -d db           # PostgreSQL en :5433

cd is-backend
cp .env.example .env
npm install                       # genera el cliente de Prisma
npm run db:deploy                 # aplica las migraciones
npm run dev:usuarios              # crea operario admin/admin1234 y repartidor con PIN 1234
npm run start:dev                 # http://localhost:3000/api/health
```

En otra terminal:

```bash
cd is-frontend
npm install
npm run dev                       # http://localhost:5173
```

> No corras `docker compose up` completo y `npm run start:dev` a la vez porque ambos utilizan el puerto `3000`.

### Credenciales locales de prueba

| Área | URL | Credenciales |
|---|---|---|
| Panel del operario | `http://localhost:5173/operario` | usuario `admin`, contraseña `admin1234` |
| Web móvil del repartidor | `http://localhost:5173/repartidor` | PIN `1234` |
| Seguimiento público | `http://localhost:5173/seguimiento/:codigo` | Sin login |

---

## Comandos útiles

| Carpeta | Comando | Descripción |
|---|---|---|
| raíz | `docker compose up -d db` | Levanta solo PostgreSQL |
| raíz | `docker compose up -d --build` | Levanta PostgreSQL y reconstruye/inicia la API |
| raíz | `docker compose down` | Detiene los contenedores conservando los datos |
| `is-backend` | `npm test` | Ejecuta las pruebas unitarias |
| `is-backend` | `npm run test:e2e` | Ejecuta las pruebas end-to-end (usa la base aislada `is_db_test`) |
| `is-backend` | `npm run lint` / `npm run build` | Linter y compilación de producción |
| `is-backend` | `npm run db:studio` | Abre Prisma Studio para inspeccionar la base |
| `is-backend` | `npm run db:seed:demo` | Carga un conjunto de datos completos para demo |
| `is-frontend` | `npm run lint` / `npm run build` | Linter y build de producción |

---

## Documentación del proyecto

| Archivo | Contenido |
|---|---|
| [`docs/`](docs/) | Documentación funcional: entrevistas, iniciativas y épicas, RNF y Plan de Gestión de Proyecto (PGP) |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Flujo de trabajo Git (ramas, commits, PRs y revisiones) |
| [`TAREAS.md`](TAREAS.md) | Especificación de tareas, modelo de datos y criterios de aceptación |
| [`AGENTS.md`](AGENTS.md) | Convenciones de arquitectura y código del repositorio |
