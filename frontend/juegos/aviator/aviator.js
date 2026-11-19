// =====================================================================
// Aviator con tormentas · navegador
//
// REGLA DE ORO: aquí NO se decide nada. El servidor (funciones aviator_*
// de la migración 006) sortea las tormentas, cobra, paga y decide si el
// avión cae. Este archivo solo:
//   * anima el vuelo con una ESTIMACIÓN del multiplicador, calculada con la
//     hora de inicio del servidor (no con el reloj del clic);
//   * llama a aviator_estado al llegar a cada tormenta para saber si pasó;
//   * muestra siempre el valor que manda el servidor cuando hay diferencia.
//
// Diseño del avión: reutiliza el SVG que dibujó un compañero en la primera
// versión de Aviator (mismos trazos, ahora pintados en el canvas).
// =====================================================================

import { supabase } from "../../js/supabase.js";

// ===== Elementos (todos los ids propios empiezan con "av") =====
const lienzo = document.getElementById("avCielo");
const ctx = lienzo.getContext("2d");
const textoMultiplicador = document.getElementById("avMultiplicador");
const aviso = document.getElementById("avAviso");
const mensaje = document.getElementById("avMensaje");
const saldoTokens = document.getElementById("avSaldo");
const inputApuesta = document.getElementById("avApuesta");
const mensajeError = document.getElementById("avError");
const btnDespegar = document.getElementById("avDespegar");
const btnRetirarse = document.getElementById("avRetirarse");
const textoGanancia = document.getElementById("avGanancia");
const botonesFicha = document.querySelectorAll(".av-ficha[data-valor]");
const btnLimpiar = document.getElementById("avLimpiar");
const historialLista = document.getElementById("avHistorialLista");
const historialVacio = document.getElementById("avHistorialVacio");

// Debe coincidir con juego.nombre en la base de datos.
const NOMBRE_JUEGO = "Aviator";
const SEGUNDOS_AVISO = 3;      // cuánto antes se avisa de una tormenta
const REINTENTO_MS = 150;      // si el servidor dice "aún no llegas", reintenta

// Los errores del servidor llegan como códigos; aquí se traducen al español.
const MENSAJES_ERROR = {
    NO_AUTENTICADO: "Tu sesión expiró. Inicia sesión de nuevo.",
    PERFIL_NO_ENCONTRADO: "No se encontró tu perfil de jugador.",
    APUESTA_INVALIDA: "La apuesta debe ser un número entero mayor a 0.",
    SALDO_INSUFICIENTE: "No tienes tokens suficientes para esa apuesta.",
    APUESTA_DEMASIADO_ALTA: "Esa apuesta es demasiado alta: el premio máximo no cabría en tu saldo.",
    JUEGO_NO_CONFIGURADO: "Aviator no está registrado en el catálogo de juegos.",
    VUELO_NO_ENCONTRADO: "No se encontró el vuelo. Recarga la página."
};

function traducirError(error) {
    const texto = error?.message || "";
    const codigo = Object.keys(MENSAJES_ERROR).find((c) => texto.includes(c));
    if (codigo) return MENSAJES_ERROR[codigo];
    console.error("Error del servidor:", error);
    return "Ocurrió un error inesperado. Intenta de nuevo.";
}

// ===== Estado =====
let idUsuario = null;
let saldo = 0;
let config = { velocidad: 0.078, maximo: 50 }; // se reemplaza con lo que mande el servidor
let tormentas = [];      // [{ m, t, cruzada, fatal, cruzadaDesde }]
let vuelo = null;        // última respuesta del servidor sobre el vuelo
let fase = "inactivo";   // inactivo | volando | cayendo | terminado
let desfaseReloj = 0;    // hora del servidor - hora del navegador (ms)
let mejorLatencia = Infinity;
let ocupado = false;     // despegar / retirarse en curso
let consultando = false; // aviator_estado en curso
let enTormenta = false;  // el avión está dentro de una nube esperando al servidor
let esperarHasta = 0;    // no volver a consultar antes de esta hora (Date.now)
let tVisual = 0;         // segundos de vuelo que se están dibujando
let multiplicadorVisual = 1;
let vista = { x: 10, y: 1.9 }; // ventana del gráfico: segundos y multiplicador máximos
let caida = null;        // { inicio, x, y } animación de caída
let rayo = null;         // { inicio, puntos }
let humo = [];           // partículas de humo
let ultimoCuadro = performance.now();
let ultimoTextoGanancia = "";

// Estrellas del fondo (solo decoración).
const estrellas = Array.from({ length: 70 }, () => ({
    x: Math.random(), y: Math.random() * 0.75, r: Math.random() * 1.3 + 0.3
}));

// ===== Avión: trazos del SVG del compañero (viewBox 0 0 220 110) =====
const AVION = {
    alaTrasera: new Path2D("M55 61 L18 91 L64 78 L88 59"),
    alaSuperior: new Path2D("M102 53 L65 12 L94 18 L143 48"),
    cuerpo: new Path2D("M24 62 Q70 46 160 40 Q186 37 196 51 Q183 65 150 68 L50 78 Z"),
    cabina: new Path2D("M130 42 Q143 25 163 33 L174 44 Z"),
    alaDelantera: new Path2D("M100 60 L61 102 L91 99 L146 60"),
    reflejo: new Path2D("M53 62 Q99 50 151 47")
};
const gradienteFuselaje = (() => {
    const g = ctx.createLinearGradient(0, 0, 220, 110);
    g.addColorStop(0, "#ff7777");
    g.addColorStop(0.55, "#e52c55");
    g.addColorStop(1, "#8e174c");
    return g;
})();

// ===== Utilidades =====
function formatear(numero) {
    return Number(numero).toLocaleString("es-MX");
}

function formatoX(m) {
    return Number(m).toFixed(2) + "×";
}

function mostrarSaldo(valor) {
    saldo = Number(valor) || 0;
    saldoTokens.textContent = formatear(saldo);
}

function mostrarMensaje(texto, clase = "") {
    mensaje.textContent = texto;
    mensaje.className = "av-mensaje" + (clase ? " " + clase : "");
}

// Misma fórmula que el servidor: multiplicador(t) = e^(velocidad · t), con tope.
function multiplicadorEn(t) {
    return Math.min(Math.exp(config.velocidad * Math.max(t, 0)), config.maximo);
}

function tiempoDe(m) {
    return Math.log(m) / config.velocidad;
}

// Ganancia posible con enteros (evita errores de redondeo de JavaScript):
// floor(apuesta × multiplicador redondeado hacia abajo a 2 decimales).
function premioEstimado(apuesta, m) {
    const centesimos = Math.floor(m * 100);
    return Math.floor((apuesta * centesimos) / 100);
}

function proximaTormenta() {
    return tormentas.find((s) => !s.cruzada);
}

// Segundos de vuelo según el reloj del SERVIDOR (estimado).
function tiempoServidor() {
    return (Date.now() + desfaseReloj - Number(vuelo.inicio_ms)) / 1000;
}

// Ajusta el desfase entre relojes con la respuesta más rápida que hayamos visto.
function sincronizar(data, enviado, recibido) {
    if (!data || data.ahora_ms == null) return;
    const latencia = recibido - enviado;
    if (latencia <= mejorLatencia * 1.5) {
        desfaseReloj = Number(data.ahora_ms) - (enviado + recibido) / 2;
        mejorLatencia = Math.min(mejorLatencia, latencia);
    }
}

async function llamar(funcion, parametros) {
    const enviado = Date.now();
    const { data, error } = await supabase.rpc(funcion, parametros);
    const recibido = Date.now();
    if (error) throw error;
    sincronizar(data, enviado, recibido);
    return data;
}

// ===== Aplicar lo que dice el servidor =====
function actualizarTormentas(lista) {
    const ahora = performance.now();
    tormentas = lista.map((s, i) => {
        const m = Number(s.m);
        const previa = tormentas[i] && tormentas[i].m === m ? tormentas[i] : null;
        const recienCruzada = s.cruzada && !(previa && previa.cruzada);
        return {
            m,
            t: tiempoDe(m),
            cruzada: s.cruzada,
            fatal: s.fatal,
            cruzadaDesde: recienCruzada ? ahora : (previa ? previa.cruzadaDesde : null)
        };
    });
}

function aplicarVista(data) {
    if (data.saldo != null) mostrarSaldo(data.saldo);
    if (data.velocidad != null) config.velocidad = Number(data.velocidad);
    if (data.maximo != null) config.maximo = Number(data.maximo);
    if (Array.isArray(data.tormentas)) actualizarTormentas(data.tormentas);

    if (data.estado === "sin_vuelo") {
        vuelo = null;
        fase = "inactivo";
        return;
    }

    vuelo = data;
    if (data.estado === "en_vuelo") {
        fase = "volando";
        textoMultiplicador.className = "av-multiplicador";
    } else if (data.estado === "caido") {
        empezarCaida(data);
    } else if (data.estado === "retirado") {
        terminarRetiro(data);
    }
}

function empezarCaida(data) {
    const crash = Number(data.multiplicador_crash);
    fase = "cayendo";
    tVisual = tiempoDe(crash);
    multiplicadorVisual = crash;
    textoMultiplicador.textContent = formatoX(crash);
    textoMultiplicador.className = "av-multiplicador av-pierde";
    aviso.hidden = true;

    const ahora = performance.now();
    rayo = { inicio: ahora, puntos: null };
    caida = { inicio: ahora + 350, x: null, y: null };
    humo = [];

    if (crash <= 1) {
        mostrarMensaje(`¡Un rayo cayó en la pista al despegar (1.00×)! Perdiste ${formatear(data.apuesta)} tokens.`, "av-pierde");
    } else {
        mostrarMensaje(`Te derribó la tormenta en ${formatoX(crash)}. Perdiste ${formatear(data.apuesta)} tokens.`, "av-pierde");
    }

    setTimeout(() => {
        if (fase === "cayendo") fase = "terminado";
    }, 1800);
    cargarHistorial();
}

function terminarRetiro(data) {
    const m = Number(data.multiplicador_retiro);
    fase = "terminado";
    // Se muestra el multiplicador del SERVIDOR, aunque la animación fuera distinta.
    tVisual = tiempoDe(m);
    multiplicadorVisual = m;
    textoMultiplicador.textContent = formatoX(m);
    textoMultiplicador.className = "av-multiplicador av-gana";
    aviso.hidden = true;

    const premio = Number(data.premio);
    const neto = premio - Number(data.apuesta);
    const inicio = m >= config.maximo
        ? `¡Llegaste al máximo (${formatoX(m)})!`
        : `¡Te retiraste en ${formatoX(m)}!`;
    const fatal = tormentas.find((s) => s.fatal && !s.cruzada);
    const pista = fatal ? ` La tormenta fatal estaba en ${formatoX(fatal.m)}.` : " Ninguna tormenta era fatal.";
    mostrarMensaje(`${inicio} Recibes ${formatear(premio)} tokens (${neto > 0 ? "+" : ""}${formatear(neto)}).${pista}`, "av-gana");
    cargarHistorial();
}

// ===== Acciones del jugador =====
async function despegar() {
    if (ocupado || fase === "volando" || fase === "cayendo") return;
    mensajeError.textContent = "";

    const apuesta = Number(inputApuesta.value);
    if (!Number.isSafeInteger(apuesta) || apuesta <= 0 || apuesta > 2147483647) {
        mensajeError.textContent = MENSAJES_ERROR.APUESTA_INVALIDA;
        return;
    }
    // El saldo lo valida el servidor (SALDO_INSUFICIENTE).

    ocupado = true;
    actualizarControles();
    mostrarMensaje("Preparando el despegue…");

    try {
        const data = await llamar("aviator_despegar", { p_apuesta: apuesta });
        reiniciarEscena();
        aplicarVista(data);
        if (data.estado === "en_vuelo") {
            mostrarMensaje(data.reanudado
                ? "Ya tenías un vuelo en el aire: lo retomamos."
                : "¡Despegaste! Retírate antes de que una tormenta te derribe.");
        }
    } catch (error) {
        mensajeError.textContent = traducirError(error);
        mostrarMensaje("Elige tu apuesta y despega.");
    } finally {
        ocupado = false;
        actualizarControles();
    }
}

async function retirarse() {
    if (fase !== "volando" || ocupado || enTormenta || !vuelo) return;
    ocupado = true; // bloquea dobles clics y las consultas de estado
    actualizarControles();

    try {
        const data = await llamar("aviator_retirarse", { p_id_vuelo: vuelo.id_vuelo });
        aplicarVista(data);
        if (data.estado === "caido") {
            mostrarMensaje(`Demasiado tarde: te derribó la tormenta en ${formatoX(data.multiplicador_crash)}.`, "av-pierde");
        }
    } catch (error) {
        mensajeError.textContent = traducirError(error);
    } finally {
        ocupado = false;
        actualizarControles();
    }
}

// Se llama al llegar a una tormenta (o al máximo).
async function consultarEstado() {
    if (!vuelo) return;
    consultando = true;
    const esperada = proximaTormenta();
    const idVuelo = vuelo.id_vuelo;

    try {
        const data = await llamar("aviator_estado", { p_id_vuelo: idVuelo });
        if (fase !== "volando" || !vuelo || vuelo.id_vuelo !== idVuelo) return;
        mensajeError.textContent = "";
        aplicarVista(data);

        if (data.estado === "en_vuelo") {
            // Si el servidor dice que aún no llegamos, nuestro reloj va adelantado: reintentar.
            const sigue = esperada && tormentas.some((s) => s.m === esperada.m && !s.cruzada);
            if (sigue || tiempoServidor() >= tiempoDe(config.maximo)) {
                esperarHasta = Date.now() + REINTENTO_MS;
            }
        }
    } catch (error) {
        mensajeError.textContent = traducirError(error) + " Reintentando…";
        esperarHasta = Date.now() + 1000;
    } finally {
        consultando = false;
    }
}

function reiniciarEscena() {
    tormentas = [];
    tVisual = 0;
    multiplicadorVisual = 1;
    caida = null;
    rayo = null;
    humo = [];
    esperarHasta = 0;
    enTormenta = false;
    vista = { x: 10, y: 1.9 };
    textoMultiplicador.textContent = formatoX(1);
    textoMultiplicador.className = "av-multiplicador";
}

// ===== Controles =====
function actualizarControles() {
    const bloqueado = ocupado || fase === "volando" || fase === "cayendo";
    btnDespegar.disabled = bloqueado;
    inputApuesta.disabled = bloqueado;
    btnLimpiar.disabled = bloqueado;
    botonesFicha.forEach((b) => { b.disabled = bloqueado; });

    btnRetirarse.disabled = fase !== "volando" || ocupado || enTormenta;

    let texto = "—";
    if (fase === "volando" && vuelo) {
        if (ocupado) texto = "Retirando…";
        else if (enTormenta) texto = "Cruzando tormenta…";
        else texto = `Cobrar ${formatear(premioEstimado(Number(vuelo.apuesta), multiplicadorVisual))} tokens`;
    }
    if (texto !== ultimoTextoGanancia) {
        textoGanancia.textContent = texto;
        ultimoTextoGanancia = texto;
    }
}

// ===== Animación =====
function avanzarVuelo(dt) {
    const real = tiempoServidor();
    const tMax = tiempoDe(config.maximo);
    const siguiente = proximaTormenta();

    let limite = Math.min(real, tMax);
    let hayQueConsultar = real >= tMax;
    enTormenta = false;
    if (siguiente && real >= siguiente.t) {
        // El avión se queda dentro de la nube hasta que el servidor responda.
        limite = Math.min(limite, siguiente.t);
        hayQueConsultar = true;
        enTormenta = true;
    }
    if (hayQueConsultar && !consultando && !ocupado && Date.now() >= esperarHasta) {
        consultarEstado();
    }

    // La animación alcanza al reloj del servidor sin saltos bruscos.
    const diferencia = limite - tVisual;
    if (diferencia > 1 || diferencia < 0) tVisual = limite;
    else tVisual = Math.min(limite, tVisual + dt * 1.6);

    multiplicadorVisual = multiplicadorEn(tVisual);
    textoMultiplicador.textContent = formatoX(Math.floor(multiplicadorVisual * 100) / 100);

    // Aviso de tormenta cercana.
    if (siguiente) {
        const restante = siguiente.t - tVisual;
        if (enTormenta) {
            aviso.textContent = `Cruzando la tormenta en ${formatoX(siguiente.m)}…`;
            aviso.className = "av-aviso av-urgente";
            aviso.hidden = false;
        } else if (restante < SEGUNDOS_AVISO) {
            aviso.textContent = `⚡ Tormenta en ${formatoX(siguiente.m)}`;
            aviso.className = "av-aviso" + (restante < 1 ? " av-urgente" : "");
            aviso.hidden = false;
        } else {
            aviso.hidden = true;
        }
    } else {
        aviso.hidden = true;
    }
}

function actualizarVentana(dt) {
    let objetivoX = 10;
    let objetivoY = 1.9;
    if (fase !== "inactivo") {
        objetivoX = Math.max(10, tVisual * 1.15 + 2);
        objetivoY = Math.max(1.9, multiplicadorVisual * 1.2);
        const siguiente = proximaTormenta();
        if (fase === "volando" && siguiente) {
            objetivoX = Math.max(objetivoX, siguiente.t + 1.5);
            objetivoY = Math.max(objetivoY, siguiente.m * 1.12);
        }
    }
    const f = Math.min(1, dt * 2.5);
    vista.x += (objetivoX - vista.x) * f;
    vista.y += (objetivoY - vista.y) * f;
}

function cuadro(ahora) {
    const dt = Math.min((ahora - ultimoCuadro) / 1000, 0.1);
    ultimoCuadro = ahora;
    if (fase === "volando") avanzarVuelo(dt);
    else enTormenta = false;
    actualizarVentana(dt);
    actualizarControles();
    dibujar(ahora);
    requestAnimationFrame(cuadro);
}

// ===== Dibujo en el canvas =====
function ajustarLienzo() {
    const dpr = window.devicePixelRatio || 1;
    lienzo.width = Math.round(lienzo.clientWidth * dpr);
    lienzo.height = Math.round(lienzo.clientHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function pasoBonito(rango, maxLineas, opciones) {
    return opciones.find((p) => rango / p <= maxLineas) || opciones[opciones.length - 1];
}

function dibujar(ahora) {
    const W = lienzo.clientWidth;
    const H = lienzo.clientHeight;
    const area = { izq: 58, der: W - 26, arr: 26, aba: H - 42 };
    const X = (t) => area.izq + (t / vista.x) * (area.der - area.izq);
    const Y = (m) => area.aba - ((m - 1) / (vista.y - 1)) * (area.aba - area.arr);

    // Cielo nocturno.
    const cielo = ctx.createLinearGradient(0, 0, 0, H);
    cielo.addColorStop(0, "#0b0820");
    cielo.addColorStop(0.6, "#1e1048");
    cielo.addColorStop(1, "#2e1065");
    ctx.fillStyle = cielo;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(255,255,255,.55)";
    estrellas.forEach((e) => {
        ctx.beginPath();
        ctx.arc(e.x * W, e.y * H, e.r, 0, Math.PI * 2);
        ctx.fill();
    });

    dibujarCuadricula(area, X, Y);

    // Suelo y pista.
    ctx.fillStyle = "#140a2e";
    ctx.fillRect(0, area.aba, W, H - area.aba);
    ctx.strokeStyle = "rgba(251,191,36,.6)";
    ctx.setLineDash([10, 8]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(8, area.aba + 14);
    ctx.lineTo(area.izq + 70, area.aba + 14);
    ctx.stroke();
    ctx.setLineDash([]);

    // Curva del vuelo.
    if (fase !== "inactivo" && tVisual > 0) {
        const pasos = 90;
        ctx.beginPath();
        ctx.moveTo(X(0), Y(1));
        for (let i = 1; i <= pasos; i++) {
            const t = (tVisual * i) / pasos;
            ctx.lineTo(X(t), Y(multiplicadorEn(t)));
        }
        const xFin = X(tVisual);
        ctx.lineTo(xFin, area.aba);
        ctx.lineTo(X(0), area.aba);
        ctx.closePath();
        const relleno = ctx.createLinearGradient(0, area.arr, 0, area.aba);
        relleno.addColorStop(0, "rgba(217,70,239,.35)");
        relleno.addColorStop(1, "rgba(139,92,246,.05)");
        ctx.fillStyle = relleno;
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(X(0), Y(1));
        for (let i = 1; i <= pasos; i++) {
            const t = (tVisual * i) / pasos;
            ctx.lineTo(X(t), Y(multiplicadorEn(t)));
        }
        ctx.strokeStyle = "#e879f9";
        ctx.lineWidth = 4;
        ctx.shadowColor = "rgba(232,121,249,.7)";
        ctx.shadowBlur = 12;
        ctx.stroke();
        ctx.shadowBlur = 0;
    }

    dibujarTormentas(ahora, area, X, Y);
    dibujarAvionYEfectos(ahora, area, X, Y);
}

function dibujarCuadricula(area, X, Y) {
    ctx.font = "600 11px Inter, sans-serif";
    ctx.fillStyle = "rgba(196,181,253,.7)";
    ctx.strokeStyle = "rgba(196,181,253,.10)";
    ctx.lineWidth = 1;

    const pasoY = pasoBonito(vista.y - 1, 5, [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20]);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let m = 1 + pasoY; m < vista.y; m += pasoY) {
        const y = Y(m);
        ctx.beginPath();
        ctx.moveTo(area.izq, y);
        ctx.lineTo(area.der, y);
        ctx.stroke();
        ctx.fillText(formatoX(m), area.izq - 8, y);
    }

    const pasoX = pasoBonito(vista.x, 8, [1, 2, 5, 10, 20]);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let t = pasoX; t < vista.x; t += pasoX) {
        const x = X(t);
        ctx.beginPath();
        ctx.moveTo(x, area.arr);
        ctx.lineTo(x, area.aba);
        ctx.stroke();
        ctx.fillText(`${t} s`, x, area.aba + 22);
    }
}

function dibujarNube(x, y, escala, colorArriba, colorAbajo, alfa, lluvia) {
    ctx.save();
    ctx.globalAlpha = alfa;
    ctx.translate(x, y);
    ctx.scale(escala, escala);
    const g = ctx.createLinearGradient(0, -30, 0, 16);
    g.addColorStop(0, colorArriba);
    g.addColorStop(1, colorAbajo);
    ctx.fillStyle = g;
    ctx.beginPath();
    [[-22, 4, 14], [-8, -8, 18], [11, -11, 20], [27, 1, 14], [2, 6, 17]].forEach(([cx, cy, r]) => {
        ctx.moveTo(cx + r, cy);
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
    });
    ctx.fill();
    if (lluvia) {
        ctx.strokeStyle = "rgba(147,197,253,.55)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        [-16, -4, 8, 20].forEach((lx, i) => {
            ctx.moveTo(lx, 22 + (i % 2) * 4);
            ctx.lineTo(lx - 4, 32 + (i % 2) * 4);
        });
        ctx.stroke();
    }
    ctx.restore();
}

function etiqueta(texto, x, y, color, fondo) {
    ctx.font = "800 12px Montserrat, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const ancho = ctx.measureText(texto).width + 12;
    ctx.fillStyle = fondo;
    ctx.beginPath();
    ctx.roundRect(x - ancho / 2, y - 10, ancho, 20, 10);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillText(texto, x, y + 1);
}

function dibujarTormentas(ahora, area, X, Y) {
    const siguiente = fase === "volando" ? proximaTormenta() : null;
    const terminado = fase === "cayendo" || fase === "terminado";

    tormentas.forEach((s, i) => {
        const x = X(s.t) + (i === 0 ? 34 : 0); // la de la pista, un poco adelante del avión
        const y = Y(s.m) - (i === 0 ? 22 : 4);
        if (x > area.der + 60 || y < area.arr - 40) return; // fuera de la ventana

        // Si están muy juntas en pantalla, se dibujan más chicas.
        const vecinos = [tormentas[i - 1], tormentas[i + 1]].filter(Boolean)
            .map((o) => Math.abs(X(o.t) - X(s.t)));
        const escala = Math.max(0.45, Math.min(1, Math.min(...vecinos, 90) / 80));
        const texto = i === 0 ? "Pista" : formatoX(s.m);

        if (s.cruzada && s.fatal) {
            // La tormenta que derribó al avión.
            dibujarNube(x, y, escala * 1.1, "#3f3a5a", "#14111f", 1, true);
            etiqueta(`⚡ ${texto}`, x, y - 40 * escala, "#fff", "rgba(220,38,38,.9)");
        } else if (s.cruzada) {
            // Ya cruzada y segura: se desvanece.
            const avance = s.cruzadaDesde ? Math.min(1, (ahora - s.cruzadaDesde) / 700) : 1;
            dibujarNube(x, y, escala, "#7c739e", "#4b4466", 0.95 - 0.7 * avance, false);
            etiqueta(`✓ ${texto}`, x, y - 40 * escala, "#052e16", `rgba(74,222,128,${0.9 - 0.4 * avance})`);
        } else if (terminado && s.fatal) {
            // Fin del vuelo: se revela dónde estaba la tormenta fatal.
            dibujarNube(x, y, escala, "#7f1d1d", "#3b0a0a", 0.65, true);
            etiqueta(`⚡ ${texto}`, x, y - 40 * escala, "#fecaca", "rgba(127,29,29,.85)");
        } else {
            const esSiguiente = siguiente === s;
            const restante = esSiguiente ? s.t - tVisual : Infinity;
            ctx.save();
            if (restante < SEGUNDOS_AVISO) {
                ctx.shadowColor = "rgba(251,191,36,.9)";
                ctx.shadowBlur = 14 + 8 * Math.sin(ahora / 120);
            }
            dibujarNube(x, y, escala, "#6d6590", "#3b3355", terminado ? 0.4 : 0.95, true);
            ctx.restore();
            etiqueta(texto, x, y - 40 * escala,
                restante < SEGUNDOS_AVISO ? "#1f1300" : "#f5f5fa",
                restante < SEGUNDOS_AVISO ? "rgba(251,191,36,.95)" : "rgba(15,10,35,.75)");
        }
    });
}

function dibujarAvion(x, y, angulo, ahora) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angulo);
    ctx.scale(0.4, 0.4);
    ctx.translate(-110, -58);
    ctx.lineJoin = "round";

    ctx.fillStyle = "#a21c5b"; ctx.strokeStyle = "#ff92bd"; ctx.lineWidth = 2;
    ctx.fill(AVION.alaTrasera); ctx.stroke(AVION.alaTrasera);

    ctx.fillStyle = "#9d1959"; ctx.strokeStyle = "#ff8db9";
    ctx.fill(AVION.alaSuperior); ctx.stroke(AVION.alaSuperior);

    ctx.fillStyle = gradienteFuselaje; ctx.strokeStyle = "#ffb3cc"; ctx.lineWidth = 3;
    ctx.fill(AVION.cuerpo); ctx.stroke(AVION.cuerpo);

    ctx.fillStyle = "#a6e8ff"; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2;
    ctx.fill(AVION.cabina); ctx.stroke(AVION.cabina);

    ctx.fillStyle = "#f44a81"; ctx.strokeStyle = "#ffb3cc";
    ctx.fill(AVION.alaDelantera); ctx.stroke(AVION.alaDelantera);

    // Hélice girando.
    ctx.save();
    ctx.translate(198, 52);
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = "#d9c8ff";
    ctx.beginPath();
    ctx.ellipse(0, 0, 4, 4 + 34 * Math.abs(Math.sin(ahora / 30)), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#ffcf49";
    ctx.beginPath();
    ctx.arc(0, 0, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.globalAlpha = 0.7; ctx.strokeStyle = "#ffd3e2"; ctx.lineWidth = 3;
    ctx.stroke(AVION.reflejo);
    ctx.restore();
}

function dibujarAvionYEfectos(ahora, area, X, Y) {
    const m = multiplicadorVisual;
    let x = X(tVisual);
    let y = Y(m) - 12;

    // Inclinación según la pendiente de la curva en pantalla.
    const dx = (area.der - area.izq) / vista.x;
    const dy = (config.velocidad * m * (area.aba - area.arr)) / (vista.y - 1);
    let angulo = fase === "inactivo" ? 0 : Math.max(-0.9, -Math.atan2(dy, dx));

    // Caída: tras el rayo, el avión cae girando y deja humo.
    if (caida) {
        if (caida.x === null) { caida.x = x; caida.y = y; }
        let e = (ahora - caida.inicio) / 1000;
        if (e > 0) {
            const suelo = area.aba - 8;
            if (caida.eImpacto !== undefined) e = caida.eImpacto; // ya en el suelo: quieto
            x = caida.x + 70 * e;
            y = Math.min(suelo, caida.y + 0.5 * 900 * e * e);
            angulo = Math.min(1.3, 0.2 + e * 2);
            if (y < suelo && Math.random() < 0.6) humo.push({ x, y, nace: ahora });
            if (y >= suelo && caida.eImpacto === undefined) {
                caida.eImpacto = e;
                for (let i = 0; i < 12; i++) humo.push({ x: x + (Math.random() - 0.5) * 30, y, nace: ahora });
            }
        } else {
            x = caida.x + (Math.random() - 0.5) * 4; // sacudida
            y = caida.y + (Math.random() - 0.5) * 4;
        }
    }

    humo = humo.filter((p) => ahora - p.nace < 1400);
    humo.forEach((p) => {
        const vida = (ahora - p.nace) / 1400;
        ctx.fillStyle = `rgba(120,113,140,${0.5 * (1 - vida)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y - vida * 30, 6 + vida * 16, 0, Math.PI * 2);
        ctx.fill();
    });

    // Brillo dorado si se retiró.
    if (fase === "terminado" && vuelo && vuelo.estado === "retirado") {
        const brillo = ctx.createRadialGradient(x, y, 4, x, y, 60);
        brillo.addColorStop(0, "rgba(251,191,36,.55)");
        brillo.addColorStop(1, "rgba(251,191,36,0)");
        ctx.fillStyle = brillo;
        ctx.beginPath();
        ctx.arc(x, y, 60, 0, Math.PI * 2);
        ctx.fill();
    }

    dibujarAvion(x, y, angulo, ahora);

    // Rayo y destello.
    if (rayo) {
        const e = ahora - rayo.inicio;
        if (e < 650) {
            const objetivoX = caida && caida.x !== null ? caida.x : x;
            const objetivoY = caida && caida.y !== null ? caida.y : y;
            if (!rayo.puntos) {
                rayo.puntos = [];
                const tramos = 8;
                for (let i = 0; i <= tramos; i++) {
                    rayo.puntos.push({
                        dx: i === tramos ? 0 : (Math.random() - 0.5) * 40,
                        f: i / tramos
                    });
                }
            }
            if (e < 180) {
                ctx.fillStyle = `rgba(255,255,255,${0.35 * (1 - e / 180)})`;
                ctx.fillRect(0, 0, lienzo.clientWidth, lienzo.clientHeight);
            }
            ctx.save();
            ctx.globalAlpha = 0.55 + 0.45 * Math.abs(Math.sin(e / 40));
            ctx.strokeStyle = "#fef9c3";
            ctx.lineWidth = 4;
            ctx.shadowColor = "#fde047";
            ctx.shadowBlur = 20;
            ctx.beginPath();
            rayo.puntos.forEach((p, i) => {
                const px = objetivoX + p.dx;
                const py = objetivoY * p.f;
                if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            });
            ctx.stroke();
            ctx.restore();
        }
    }
}

// ===== Historial (lectura directa: la política RLS solo deja ver lo propio) =====
let idJuego = null;

async function obtenerIdJuego() {
    if (idJuego !== null) return idJuego;
    // La política juego_leer_activos deja leer los juegos con estado = true.
    const { data, error } = await supabase
        .from("juego")
        .select("id_juego")
        .eq("nombre", NOMBRE_JUEGO)
        .single();
    if (error) {
        console.error("Error al buscar el juego:", error.message);
        return null;
    }
    idJuego = data.id_juego;
    return idJuego;
}

async function cargarHistorial() {
    const id = await obtenerIdJuego();
    if (id === null) return;

    const { data, error } = await supabase
        .from("partida")
        .select("fecha_hora, apuesta, premio, resultado")
        .eq("id_usuario", idUsuario)
        .eq("id_juego", id)
        .order("fecha_hora", { ascending: false })
        .limit(10);

    if (error) {
        console.error("Error al cargar el historial:", error.message);
        return;
    }

    historialLista.innerHTML = "";
    historialVacio.hidden = data.length > 0;

    const ESTADOS = {
        GANADA: { clase: "av-gana", texto: "Ganó" },
        EMPATE: { clase: "av-empate", texto: "Empate" },
        PERDIDA: { clase: "av-pierde", texto: "Perdió" }
    };

    data.forEach((partida) => {
        const info = ESTADOS[partida.resultado] || ESTADOS.PERDIDA;
        const li = document.createElement("li");

        const fecha = document.createElement("span");
        fecha.className = "av-fecha";
        fecha.textContent = new Date(partida.fecha_hora)
            .toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });

        const apuesta = document.createElement("span");
        apuesta.className = "av-monto";
        apuesta.title = "Apostado";
        apuesta.textContent = `${formatear(partida.apuesta)} tk`;

        const premio = document.createElement("span");
        premio.className = "av-monto " + info.clase;
        premio.title = "Premio";
        premio.textContent = `→ ${formatear(partida.premio)}`;

        const estado = document.createElement("span");
        estado.className = "av-estado " + info.clase;
        estado.textContent = info.texto;

        li.append(fecha, apuesta, premio, estado);
        historialLista.appendChild(li);
    });
}

// ===== Eventos =====
btnDespegar.addEventListener("click", despegar);
btnRetirarse.addEventListener("click", retirarse);
botonesFicha.forEach((b) => b.addEventListener("click", () => {
    const actual = Number(inputApuesta.value) || 0;
    inputApuesta.value = Math.max(0, Math.floor(actual)) + Number(b.dataset.valor);
}));
btnLimpiar.addEventListener("click", () => { inputApuesta.value = ""; inputApuesta.focus(); });
window.addEventListener("resize", ajustarLienzo);

// ===== Inicio: sesión, vuelo pendiente, saldo e historial =====
async function iniciar() {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
        window.location.replace("../../login.html");
        return;
    }
    idUsuario = data.user.id;

    ajustarLienzo();
    requestAnimationFrame(cuadro);

    try {
        // Si recargó a medio vuelo, aquí se retoma (o se resuelve si ya cayó).
        const actual = await llamar("aviator_vuelo_actual", {});
        aplicarVista(actual);
        if (actual.estado === "en_vuelo") {
            mostrarMensaje("Retomamos tu vuelo en curso. ¡Decide a tiempo!");
        } else if (actual.reanudado) {
            mostrarMensaje("Mientras no estabas: " + mensaje.textContent, mensaje.className.replace("av-mensaje", "").trim());
        } else {
            mostrarMensaje("Elige tu apuesta y pulsa Apostar y despegar.");
        }
    } catch (e) {
        mensajeError.textContent = traducirError(e);
        mostrarMensaje("No se pudo conectar con el juego.");
    }

    actualizarControles();
    cargarHistorial();
}

iniciar();
