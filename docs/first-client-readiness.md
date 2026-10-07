# Preparación del primer cliente

Fuente principal: análisis entregado por Larios en el chat el 6 de octubre de 2026. El análisis anterior de Square complementa el catálogo; no sustituye este criterio. Segmento de evaluación: cafetería pequeña, un local, una caja y conexión a internet. Es una hipótesis de piloto, no evidencia de un cliente contratado o de sus equipos.

La prioridad es completar la venta de principio a fin con el motor existente. No se reconstruyen módulos que ya operan. «Listo» exige autorización, persistencia, dinero exacto, recuperación y una interfaz comprobada; una prueba local no acredita producción ni hardware físico.

## Decisión de implementación

| Requisito del análisis | Trabajo de software y criterio | Validación que queda fuera de una prueba local |
| --- | --- | --- |
| Venta según el modo del negocio | Integrar la elección Mostrador/Cuentas de configuración con Venta. Mostrador cobra y genera comanda; Cuentas guarda consumos, envía cantidades nuevas y cobra después. Conserva acceso a cuentas existentes al cambiar de modo. Entrega en PR #26, integrada en dev. | Confirmar con el dueño qué modo usa y recorrerlo en sus equipos. |
| Cobro compatible con el comercio | Efectivo con cambio y transferencia confirmada; habilitar **Tarjeta externa** como registro manual de un cobro aprobado en la terminal del comercio. Mantener **Mercado Pago Point** como método integrado separado, con sus propios controles y recuperación. | Point requiere terminal/modelo, cuenta y prueba física. El registro externo no controla Clip ni una terminal bancaria, ni acredita su liquidación. |
| Catálogo suficiente para el menú | Productos, precios, variantes, extras obligatorios/opcionales y agotado manual. El catálogo ampliado de PR #28 está integrado en dev. | Cargar y comprobar el menú real del cliente; no hay menú proporcionado en este encargo. |
| Comandas utilizables | Comprobar cantidades, extras, notas, cancelaciones y avance de preparación con datos sintéticos persistidos. | Probar visibilidad y uso en los dispositivos de cocina concretos. |
| Caja y cierre | Añadir el desglose de cobrado/devuelto/neto por método **del turno**; el reporte diario existente no sustituye ese corte. Comprobar apertura, entradas/salidas, conteo y diferencia. Conservar conteo ciego y distinguir tarjeta externa de Point. | El dueño debe verificar y entender los totales; un cierre del POS no concilia depósitos bancarios. |
| Comprobante de venta | Añadir **Imprimir / guardar PDF** a la venta confirmada y recuperada en Ventas. Usa snapshots, zona horaria y método original; identifica los pagos parciales y los conceptos libres. | El diálogo y los destinos son del navegador/dispositivo. Una impresora térmica exige prueba de su controlador, papel y equipo. No es CFDI. |
| Correcciones y devoluciones | Corregir antes del pago y registrar una devolución manual **completa por recibo**, conservando el original y su historial vinculado. Terminal externa exige una devolución hecha y confirmada fuera del POS; Point sigue su recorrido integrado. Comprobar permisos, recuperación y efecto en caja/reportes. | No hay devolución manual parcial por artículo. Reembolso físico, rechazo o incertidumbre de Point y devolución de la terminal del comercio requieren comprobación real. |
| Recuperación y acceso | Comprobar respuesta perdida, recarga, desbloqueo y reintento con identidad original, sin repetir el cobro. Mantener permisos y aislamiento del negocio/empleado en servidor. | Google alojado, instalación de PWA y los accesos personales/caja compartida del piloto requieren prueba real. |

El desarrollo nuevo de esta etapa es comprobantes, exposición explícita del registro externo y desglose de caja por turno. Cuentas e importe libre ya cuentan con entregas separadas (#26/#27); se conserva la vista conjunta de dev. No se fusiona ni publica por haber completado estas pruebas: revisión humana y backend compatible siguen DEPLOYMENT.md.

## Requisitos condicionados por el comercio

| Necesidad del cliente | Decisión |
| --- | --- |
| Servicios/conceptos fuera del menú | Importe libre con concepto, historial y comprobante. PR #27 ya lo registra; el comprobante conserva el concepto original. |
| Mesas y división habitual | Cuentas y división por artículos/importe tienen interfaz y motor. Mesas y traslado tienen contratos/SQL, **sin interfaz en la PWA actual**. Si el comercio los necesita, falta implementar y comprobar ese recorrido antes de instalar. Verificar descuentos/IVA y recuperación de la división que utilice. |
| Cocina con papel | Entregar impresión estándar del comprobante de venta no completa impresión de comandas. El flujo de cocina en papel y su impresora concreta quedan pendientes de conocer/probar equipo y necesidad. |
| Dependencia de operación sin conexión | Fuera de este piloto. No implementar cobros offline o respuestas simuladas; el reintento guardado no equivale a venta offline. |
| Facturación fiscal o delivery dentro del POS | Posponer hasta definir proveedor, requisitos y recorrido operativo. El comprobante no timbra CFDI ni promete entrega. |

Pueden esperar importación CSV, menú QR, CRM, fidelización, reportes personalizados, temporizadores avanzados, biometría, reloj checador, multisucursal e inventario por receta. No se añaden en esta etapa mientras el comercio seleccionado pueda operar sin ellos. Si aparece una dependencia real, se vuelve a evaluar su alcance antes del piloto.

## Recorrido de aceptación

Preparar un negocio sintético y recorrer: **configurar menú → abrir caja → vender/comandar → cobrar → recuperar una operación interrumpida → corregir o devolver → cerrar y explicar los totales**. Comprobar cada método que la configuración ofrece; las pruebas de registro externo no representan una autorización bancaria. Repetir con el dueño y los equipos reales antes de instalar para operar.

Evidencia de código y pruebas de la nueva entrega se registra en el PR correspondiente. Los documentos locales de operaciones, pagos, acceso y pruebas se contrastan con los contratos y migraciones actuales. Se consultaron Drive 02, 04 y las últimas entradas de 05 (actualizaciones de 1/2 de octubre), conservando autor/fecha y el carácter histórico de sus recomendaciones. Drive no se modificó.
