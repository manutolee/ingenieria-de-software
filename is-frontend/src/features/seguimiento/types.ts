export type EstadoEnvio =
  | 'PENDIENTE'
  | 'ASIGNADO'
  | 'EN_CAMINO_A_RETIRAR'
  | 'RETIRADO'
  | 'EN_DOMICILIO'
  | 'INTERRUMPIDO'
  | 'PARADO'
  | 'CON_NOVEDAD'
  | 'A_DEVOLVER'
  | 'ENTREGADO'
  | 'CANCELADO';

export interface HistorialEstadoItem {
  estado: EstadoEnvio;
  fecha: string; // ISO string
}

export interface TrackingResponseDto {
  trackingCode: string;
  estadoActual: EstadoEnvio;
  comercio?: string;
  destinatario?: string;
  direccionDestino?: string;
  horaSalida?: string;
  franjaEstimadaInicio?: string;
  franjaEstimadaFin?: string;
  fechaEntrega?: string;
  avisoReprogramacion?: string
  historial: HistorialEstadoItem[];
}
