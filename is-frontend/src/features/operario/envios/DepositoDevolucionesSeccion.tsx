import { useCallback, useState, type FormEvent } from 'react'
import { api, ErrorApi } from '../../../shared/api'
import { Boton } from '../../../shared/ui/Boton'
import { Campo } from '../../../shared/ui/Campo'
import { Selector } from '../../../shared/ui/Selector'
import { usePolling } from '../../../shared/usePolling'

// ============================================================================
// SECCIÓN DE DEPÓSITO Y DEVOLUCIONES DEL OPERARIO (HU37, HU38 y HU40)
// ============================================================================
// GUÍA DE INGENIERÍA INVERSA (Para revisar con Salvador):
// Este componente agrupa las tres operaciones del operario sobre el depósito:
// 1. HU40 ("Devoluciones pendientes"): muestra alertas por paquetes con >= 24 h
//    en custodia sin orden de devolución (se actualiza cada 15 s por polling).
// 2. HU37 ("Registrar reingreso al depósito"): permite ingresar el código de
//    seguimiento de un paquete de la jornada de un repartidor y pasarlo a "En custodia".
// 3. HU38 ("Ordenar devolución al comercio"): filtra por comercio los paquetes
//    en custodia disponibles (sin orden previa) y genera la orden de devolución.
// ============================================================================

interface ComercioOpcion {
  id: number
  nombre: string
}

interface AlertaCustodia {
  envioId: number
  codigoSeguimiento: string
  comercio: { id: number; nombre: string; direccion: string }
  fechaReingreso: string
  horasEnCustodia: number
}

interface PaqueteEnCustodia {
  envioId: number
  codigoSeguimiento: string
  destinoOriginal: string
  tamanio: string
  fechaReingreso: string | null
  horasEnCustodia: number
}

interface RespuestaCustodiaComercio {
  comercio: { id: number; nombre: string; direccion: string }
  paquetes: PaqueteEnCustodia[]
}

export function DepositoDevolucionesSeccion({
  comercios,
  alActualizarEnvios,
}: {
  comercios: ComercioOpcion[]
  alActualizarEnvios?: () => void
}) {
  // --- Estado HU40: Alertas de paquetes demorados (>= 24 h en custodia) ---
  const [alertas, setAlertas] = useState<AlertaCustodia[]>([])

  // --- Estado HU38: Ordenar devolución al comercio ---
  const [comercioIdOrden, setComercioIdOrden] = useState('')
  const [paquetesCustodia, setPaquetesCustodia] = useState<PaqueteEnCustodia[]>([])
  const [seleccionados, setSeleccionados] = useState<number[]>([])
  const [cargandoCustodia, setCargandoCustodia] = useState(false)
  const [creandoOrden, setCreandoOrden] = useState(false)
  const [mensajeOrden, setMensajeOrden] = useState<string | null>(null)
  const [errorOrden, setErrorOrden] = useState<string | null>(null)

  const cargarAlertas = useCallback(async () => {
    try {
      const datos = await api<AlertaCustodia[]>('/envios/deposito/alertas')
      setAlertas(Array.isArray(datos) ? datos : [])
    } catch {
      // Si falla un ciclo de polling se conserva la lista anterior.
    }
  }, [])

  // Refresco cada 15 s como el resto del panel del operario.
  usePolling(cargarAlertas, 15_000)

  const consultarCustodiaComercio = async (idComercio: string) => {
    setComercioIdOrden(idComercio)
    setPaquetesCustodia([])
    setSeleccionados([])
    setMensajeOrden(null)
    setErrorOrden(null)

    if (!idComercio) return

    setCargandoCustodia(true)
    try {
      const respuesta = await api<RespuestaCustodiaComercio>(
        `/envios/deposito/custodia?comercioId=${encodeURIComponent(idComercio)}`,
      )
      setPaquetesCustodia(respuesta.paquetes)
      setSeleccionados(respuesta.paquetes.map((p) => p.envioId))
    } catch (err) {
      // Escenario 2 de HU38: "No hay paquetes en custodia para este comercio"
      setErrorOrden(
        err instanceof ErrorApi
          ? err.message
          : 'No se pudieron consultar los paquetes en custodia.',
      )
    } finally {
      setCargandoCustodia(false)
    }
  }

  const alternarPaquete = (envioId: number) => {
    setSeleccionados((prev) =>
      prev.includes(envioId) ? prev.filter((id) => id !== envioId) : [...prev, envioId],
    )
  }

  const crearOrdenDevolucion = async (evento: FormEvent) => {
    evento.preventDefault()
    if (!comercioIdOrden || seleccionados.length === 0) return

    setCreandoOrden(true)
    setErrorOrden(null)
    setMensajeOrden(null)

    try {
      await api('/envios/deposito/ordenes-devolucion', {
        metodo: 'POST',
        datos: {
          comercioId: Number(comercioIdOrden),
          envioIds: seleccionados,
        },
      })
      setMensajeOrden(
        `Orden de devolución creada con ${seleccionados.length} ${
          seleccionados.length === 1 ? 'paquete' : 'paquetes'
        } y enviada a asignación automática.`,
      )
      // Actualiza alertas (HU40 Escenario 3: la alerta desaparece al generar la orden)
      await cargarAlertas()
      setPaquetesCustodia((prev) => prev.filter((p) => !seleccionados.includes(p.envioId)))
      setSeleccionados([])
      alActualizarEnvios?.()
    } catch (err) {
      setErrorOrden(
        err instanceof ErrorApi ? err.message : 'No se pudo crear la orden de devolución.',
      )
    } finally {
      setCreandoOrden(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* HU40: Sección "Devoluciones pendientes" (alerta por paquetes con >= 24 h en custodia) */}
      {alertas.length > 0 && (
        <section
          aria-label="Devoluciones pendientes"
          className="rounded-xl border-2 border-amber-400 bg-amber-50 p-5 shadow-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-lg font-bold text-amber-900">
                ⚠️ Devoluciones pendientes ({alertas.length})
              </h2>
              <p className="text-sm text-amber-800">
                Paquetes que cumplen 24 horas o más en custodia sin orden de devolución.
              </p>
            </div>
          </div>

          <ul className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {alertas.map((alerta) => (
              <li
                key={alerta.envioId}
                className="flex items-center justify-between rounded-lg border border-amber-300 bg-white p-3 shadow-xs"
              >
                <div>
                  <p className="font-mono text-sm font-bold text-slate-900">
                    #{alerta.codigoSeguimiento}
                  </p>
                  <p className="text-xs font-medium text-slate-600">{alerta.comercio.nombre}</p>
                </div>
                <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-extrabold text-amber-900">
                  {alerta.horasEnCustodia} h en custodia
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* HU38: Agrupar paquetes en custodia por comercio y generar orden de devolución */}
      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <h2 className="text-lg font-bold text-slate-800">
            Custodia en depósito y órdenes de devolución
          </h2>
          <p className="text-sm text-slate-600">
            Elegí un comercio para ver sus paquetes en custodia y generar una orden de devolución hacia su origen.
          </p>
        </div>

        <form onSubmit={crearOrdenDevolucion} className="space-y-4">
          <div className="max-w-md">
            <Selector
              etiqueta="Comercio de origen"
              value={comercioIdOrden}
              onChange={(e) => void consultarCustodiaComercio(e.target.value)}
              opciones={[
                { valor: '', etiqueta: 'Seleccionar comercio...' },
                ...comercios.map((c) => ({ valor: String(c.id), etiqueta: c.nombre })),
              ]}
            />
          </div>

          {cargandoCustodia && (
            <p className="text-sm text-slate-500">Consultando paquetes en custodia…</p>
          )}

          {errorOrden && (
            <p
              role="alert"
              className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700"
            >
              {errorOrden}
            </p>
          )}

          {mensajeOrden && (
            <p
              role="status"
              className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-800"
            >
              {mensajeOrden}
            </p>
          )}

          {paquetesCustodia.length > 0 && (
            <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-semibold text-slate-700">
                Paquetes disponibles en custodia ({paquetesCustodia.length}):
              </p>
              <ul className="space-y-2">
                {paquetesCustodia.map((paquete) => (
                  <li
                    key={paquete.envioId}
                    className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                  >
                    <label className="flex cursor-pointer items-center gap-3">
                      <input
                        type="checkbox"
                        checked={seleccionados.includes(paquete.envioId)}
                        onChange={() => alternarPaquete(paquete.envioId)}
                        className="h-4 w-4 rounded border-slate-300 text-blue-600"
                      />
                      <span className="font-mono font-bold text-slate-900">
                        {paquete.codigoSeguimiento}
                      </span>
                      <span className="text-slate-600">{paquete.destinoOriginal}</span>
                    </label>
                    <span className="text-xs font-medium text-slate-500">
                      {paquete.horasEnCustodia} h en custodia
                    </span>
                  </li>
                ))}
              </ul>

              <div className="pt-2">
                <Boton
                  type="submit"
                  disabled={creandoOrden || seleccionados.length === 0}
                >
                  {creandoOrden ? 'Creando orden...' : 'Crear orden de devolución'}
                </Boton>
              </div>
            </div>
          )}
        </form>
      </section>
    </div>
  )
}

// Subcomponente reutilizable para HU37: permite confirmar el reingreso de un paquete
// por su código de seguimiento durante la rendición de la jornada de un repartidor.
export function FormularioReingresoDeposito({
  repartidorId,
  alReingresar,
}: {
  repartidorId: number
  alReingresar: () => void
}) {
  const [codigo, setCodigo] = useState('')
  const [confirmando, setConfirmando] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exito, setExito] = useState<string | null>(null)

  const confirmarReingreso = async (evento: FormEvent) => {
    evento.preventDefault()
    if (!codigo.trim()) return

    setConfirmando(true)
    setError(null)
    setExito(null)

    try {
      await api('/envios/deposito/reingreso', {
        metodo: 'POST',
        datos: {
          repartidorId,
          codigoSeguimiento: codigo.trim(),
        },
      })
      setExito(`Paquete ${codigo.trim().toUpperCase()} registrado En custodia.`)
      setCodigo('')
      alReingresar()
    } catch (err) {
      // Muestra los mensajes exactos de HU37 Escenario 2 y Escenario 3:
      // - "El paquete no pertenece a la jornada de este repartidor"
      // - "El código no corresponde a ningún envío"
      setError(
        err instanceof ErrorApi ? err.message : 'No se pudo registrar el reingreso.',
      )
    } finally {
      setConfirmando(false)
    }
  }

  return (
    <form
      onSubmit={confirmarReingreso}
      className="space-y-3 rounded-lg border border-blue-200 bg-blue-50/60 p-3"
    >
      <p className="text-xs font-semibold text-blue-900">
        Registrar reingreso de paquete al depósito (En custodia)
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Campo
            etiqueta="Código de seguimiento"
            placeholder="Ej.: ABC1234567"
            value={codigo}
            onChange={(e) => {
              setCodigo(e.target.value)
              setError(null)
            }}
          />
        </div>
        <Boton type="submit" disabled={confirmando || !codigo.trim()}>
          {confirmando ? 'Confirmando…' : 'Confirmar reingreso'}
        </Boton>
      </div>
      {error && (
        <p role="alert" className="text-xs font-semibold text-red-700">
          {error}
        </p>
      )}
      {exito && (
        <p role="status" className="text-xs font-semibold text-emerald-700">
          {exito}
        </p>
      )}
    </form>
  )
}
