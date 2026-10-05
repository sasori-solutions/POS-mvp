# Transiciones de cobro y entrega acumulada

## Solicitud y alcance

Larios solicitó el 4 de octubre de 2026 corregir el cambio brusco de interfaz entre métodos de pago y publicar a live sin una revisión humana adicional. Esta autorización corresponde a esta entrega; no modifica el procedimiento general ni la configuración de revisiones del repositorio. Se conserva el PR existente #24 y los gates técnicos de Basic checks y Required financial checks.

La entrega conserva el trabajo acumulado del worktree propio: preferencias y perfiles del negocio, comandas, navegación del empleado, métricas propias, notificaciones y división por cantidad. Las fuentes y límites de esas funciones se describen en [la revisión de operaciones](business-operations-review-2026-10-04.md) y [Dividir por cantidad](amount-split-checkout.md). El worktree ajeno usado como fuente de la división por cantidad permanece intacto.

## Causa y comportamiento esperado

El método elegido en el cliente cambiaba antes que la reserva confirmada por el servidor. El botón manual desaparecía de inmediato, mientras Point se montaba fuera del bloque de pago según el método de la reserva anterior. Al iniciar la terminal también desaparecían los selectores y el foco saltaba al encabezado de Point.

El bloque de pago debe mantener los selectores, desactivándolos cuando el intento no admite cambios. La acción correspondiente se habilita únicamente cuando coincide con la reserva vigente. El área de acciones coordina altura y fundido breves, cancela transiciones anteriores y respeta `prefers-reduced-motion`. Los estados de un cobro iniciado continúan visibles; una animación no confirma dinero ni sustituye la respuesta del backend.

La implementación usa altura de 160 ms y fundido de 120 ms. Conserva el foco del selector y responde inmediatamente a cambios de ancho o movimiento reducido. Una reserva tardía de tarjeta ya iniciada recupera el método antes de pintar; sus controles permanecen bloqueados. La recuperación manual de intentos antiguos tiene una sola acción en `AttemptPanel`, sin un segundo botón de registro.

## Verificación local de esta corrección

Pasaron **347/347 pruebas unitarias** y **388/388 pruebas de componentes** en la suite completa. Ocho casos nuevos verifican continuidad, respuestas tardías, bloqueo de Point, recibo con saldo cero, reduced motion, resize y cancelación de animaciones. Se detectó y corrigió el botón duplicado de recuperación mediante la prueba existente, conservando sus assertions. Build, lint, comprobación Deno de `account` y revisión del diff pasaron. El build confirma que no incluye acceso ni credenciales de desarrollo. El servidor de desarrollo 5181 permanece disponible.

Los selectores de las pruebas E2E se actualizaron para la navegación actual del empleado, sus permisos de métricas y la bandeja de notificaciones. Se mantienen las verificaciones de permisos, foco, geometría, bloqueo y respuestas tardías; la ejecución automatizada completa corresponde a CI.

## Publicación y límites

El backend compatible se aplica antes de fusionar el frontend. Se verifican historia y funciones actuales del proyecto alojado antes de añadir las cinco migraciones nuevas y desplegar `account`; no se reinician datos ni se modifican snapshots históricos.

El backend quedó verificado con 59 migraciones, `account` v21, 170 funciones comparadas con la fuente, 233 pruebas SQL locales y 31 comprobaciones HTTP alojadas. La evidencia y los límites están en [la publicación del backend](backend-release-2026-10-04.md).

La publicación del frontend usa exclusivamente el artefacto producido por CI para el commit fusionado. La revisión visual permanece a cargo de Larios, conforme a su instrucción de no usar el navegador para comprobar el diseño. Las pruebas con el proveedor sintético local no acreditan una terminal física ni una transacción real de Mercado Pago.
