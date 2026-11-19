// Ruleta: este archivo SOLO arma las apuestas, anima y muestra lo que
// responde el servidor. El número se sortea y los tokens se mueven en la
// función ruleta_girar de Supabase (ver supabase/migraciones/005_ruleta.sql).

import { supabase } from "../../js/supabase.js";

// ===== Elementos de la página (todos los ids propios empiezan con "rl") =====
const saldoTokens = document.getElementById("saldoTokens");
const grupoRueda = document.getElementById("rlRuedaGiro");
const grupoBola = document.getElementById("rlBolaGiro");
const bola = document.getElementById("rlBola");
const numeroGrande = document.getElementById("rlNumeroGrande");
const colorGrande = document.getElementById("rlColorGrande");
const mensajeMesa = document.getElementById("rlMensaje");
const listaDetalle = document.getElementById("rlDetalle");
const cajaTotales = document.getElementById("rlTotales");
const textoPremioTotal = document.getElementById("rlPremioTotal");
const textoGananciaNeta = document.getElementById("rlGananciaNeta");
const contBolitas = document.getElementById("rlBolitas");
const bolitasVacio = document.getElementById("rlBolitasVacio");
const historialLista = document.getElementById("rlHistorialLista");
const historialVacio = document.getElementById("rlHistorialVacio");
const pano = document.getElementById("rlPano");
const botonesFicha = document.querySelectorAll(".rl-ficha-valor");
const mensajeError = document.getElementById("rlError");
const textoTotal = document.getElementById("rlTotalApostado");
const btnDeshacer = document.getElementById("rlDeshacer");
const btnLimpiar = document.getElementById("rlLimpiar");
const btnRepetir = document.getElementById("rlRepetir");
const btnGirar = document.getElementById("rlGirar");

// Debe coincidir con juego.nombre en la base de datos.
const NOMBRE_JUEGO = "Ruleta";
const MAX_APUESTAS = 20; // el servidor también lo valida

// ===== Datos de la ruleta europea (solo para dibujar) =====
const ROJOS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
// Orden real de los casilleros en la rueda, en sentido horario.
const ORDEN_RUEDA = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10,
    5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const GRADOS_CASILLA = 360 / 37;

function colorDe(numero) {
    if (numero === 0) return "verde";
    return ROJOS.has(numero) ? "rojo" : "negro";
}

// ===== Estado local (solo para pintar; no decide nada) =====
let saldo = 0;
let idUsuario = null;
let ocupado = false;              // true mientras esperamos al servidor y dura la animación
let valorFicha = 10;
// Apuestas puestas en el paño: clave "tipo:valor" -> { tipo, valor, cantidad }
let apuestas = new Map();
// Cada clic (o "Repetir") deja una entrada para poder deshacerla:
// una lista de { clave, tipo, valor, cantidad } que se sumaron.
let pilaDeshacer = [];
let apuestasAnteriores = [];      // lo último que se envió con éxito
let numerosSesion = [];           // últimos 10 números (en memoria)

// Los errores del servidor llegan como códigos; aquí se traducen al español.
// Mismos textos que en los otros juegos, más APUESTAS_INVALIDAS.
const MENSAJES_ERROR = {
    NO_AUTENTICADO: "Tu sesión expiró. Inicia sesión de nuevo.",
    PERFIL_NO_ENCONTRADO: "No se encontró tu perfil de jugador.",
    APUESTAS_INVALIDAS: `Debes poner entre 1 y ${MAX_APUESTAS} apuestas distintas.`,
    APUESTA_INVALIDA: "Hay una apuesta inválida: revisa el tipo, el valor y que la cantidad sea un entero mayor a 0.",
    SALDO_INSUFICIENTE: "No tienes tokens suficientes para esa apuesta.",
    JUEGO_NO_CONFIGURADO: "La Ruleta no está registrada en el catálogo de juegos."
};

function traducirError(error) {
    const texto = error?.message || "";
    const codigo = Object.keys(MENSAJES_ERROR).find((c) => texto.includes(c));
    if (codigo) return MENSAJES_ERROR[codigo];
    console.error("Error del servidor:", error);
    return "Ocurrió un error inesperado. Intenta de nuevo.";
}

function formatear(numero) {
    return Number(numero).toLocaleString("es-MX");
}

function mostrarSaldo(valor) {
    saldo = Number(valor) || 0;
    saldoTokens.textContent = formatear(saldo);
}

function mostrarMensaje(texto, clase = "") {
    mensajeMesa.textContent = texto;
    mensajeMesa.className = "mensaje-mesa" + (clase ? " " + clase : "");
}

// Texto corto para una apuesta: "Pleno 17", "Rojo", "1ª docena"...
function describir(tipo, valor) {
    switch (tipo) {
        case "pleno": return `Pleno ${valor}`;
        case "color": return valor === "ROJO" ? "Rojo" : "Negro";
        case "paridad": return valor === "PAR" ? "Par" : "Impar";
        case "mitad": return valor === "BAJA" ? "1 a 18" : "19 a 36";
        case "docena": return `${valor}ª docena`;
        case "columna": return `Columna ${valor}`;
        default: return `${tipo} ${valor}`;
    }
}

// =====================================================================
// Rueda en SVG
// Los ángulos se miden en grados, desde arriba y en sentido horario
// (como las agujas del reloj). El casillero i de ORDEN_RUEDA está centrado
// en i * GRADOS_CASILLA cuando la rueda no está girada.
// =====================================================================
const SVG_NS = "http://www.w3.org/2000/svg";
const R_BORDE = 200, R_PISTA = 188, R_EXT = 176, R_INT = 122, R_NUM = 160, R_CONO = 92;
const R_BOLA_CASILLA = 135; // donde queda la bolita al caer en el casillero

function punto(radio, grados) {
    const rad = (grados * Math.PI) / 180;
    return [radio * Math.sin(rad), -radio * Math.cos(rad)];
}

function crearSvg(etiqueta, atributos) {
    const el = document.createElementNS(SVG_NS, etiqueta);
    for (const [k, v] of Object.entries(atributos)) el.setAttribute(k, v);
    return el;
}

function dibujarRueda() {
    // Borde de madera y pista por donde corre la bolita (no giran con los números,
    // pero da igual porque son círculos lisos).
    grupoRueda.before(crearSvg("circle", { r: R_BORDE, class: "rl-borde-madera" }));
    grupoRueda.before(crearSvg("circle", { r: R_PISTA + 8, class: "rl-pista" }));

    ORDEN_RUEDA.forEach((numero, i) => {
        const centro = i * GRADOS_CASILLA;
        const a1 = centro - GRADOS_CASILLA / 2;
        const a2 = centro + GRADOS_CASILLA / 2;
        const [x1, y1] = punto(R_EXT, a1);
        const [x2, y2] = punto(R_EXT, a2);
        const [x3, y3] = punto(R_INT, a2);
        const [x4, y4] = punto(R_INT, a1);

        // Sector de anillo: arco exterior, línea hacia adentro, arco interior de regreso.
        grupoRueda.appendChild(crearSvg("path", {
            d: `M${x1},${y1} A${R_EXT},${R_EXT} 0 0 1 ${x2},${y2} L${x3},${y3} A${R_INT},${R_INT} 0 0 0 ${x4},${y4} Z`,
            class: `rl-casilla ${colorDe(numero)}`
        }));

        const [tx, ty] = punto(R_NUM, centro);
        const texto = crearSvg("text", {
            x: tx, y: ty, class: "rl-casilla-num",
            transform: `rotate(${centro} ${tx} ${ty})`
        });
        texto.textContent = numero;
        grupoRueda.appendChild(texto);
    });

    // Cono central dorado con una cruz (para que se note el giro).
    grupoRueda.appendChild(crearSvg("circle", { r: R_INT, class: "rl-cono-int" }));
    grupoRueda.appendChild(crearSvg("circle", { r: R_CONO, class: "rl-cono" }));
    for (const g of [0, 90]) {
        const [x1, y1] = punto(R_CONO - 18, g);
        const [x2, y2] = punto(R_CONO - 18, g + 180);
        grupoRueda.appendChild(crearSvg("line", { x1, y1, x2, y2, class: "rl-radio" }));
    }
    grupoRueda.appendChild(crearSvg("circle", { r: 14, class: "rl-cono-int" }));
}

// ===== Animación de la rueda y la bolita =====
// Todo con requestAnimationFrame para que el paso de "girando" a "frenando"
// sea continuo. El número final lo decide el servidor: aquí solo se calcula
// hacia qué ángulo frenar para que ese número quede bajo el marcador.
const VELOCIDAD = 360 / 900;          // rueda: grados por milisegundo (1 vuelta cada 0.9 s)
const VELOCIDAD_BOLA = 360 / 600;     // bolita: más rápida y en sentido contrario
const MS_GIRO_MINIMO = 1200;          // giro libre mínimo antes de empezar a frenar
const VUELTAS_FRENADO = 1;            // vueltas mínimas durante el frenado (≥ 1.8 s)

let anguloRueda = 0;   // grados, sentido horario
let anguloBola = 0;    // grados, va hacia negativo (antihorario)
let radioBola = R_PISTA;
let idFrame = null;

// Residuo siempre positivo (en JS, -30 % 360 da -30).
function modulo(a, n) {
    return ((a % n) + n) % n;
}

function aplicarTransformacion() {
    grupoRueda.setAttribute("transform", `rotate(${anguloRueda})`);
    grupoBola.setAttribute("transform", `rotate(${anguloBola})`);
    bola.setAttribute("cy", String(-radioBola));
}

function empezarGiro() {
    cancelAnimationFrame(idFrame);
    const inicio = performance.now();
    const ruedaInicio = anguloRueda;
    const bolaInicio = anguloBola;
    radioBola = R_PISTA;

    const paso = (ahora) => {
        const t = ahora - inicio;
        anguloRueda = ruedaInicio + t * VELOCIDAD;
        anguloBola = bolaInicio - t * VELOCIDAD_BOLA;
        aplicarTransformacion();
        idFrame = requestAnimationFrame(paso);
    };
    idFrame = requestAnimationFrame(paso);
}

// Frena hasta dejar `numero` bajo el marcador (arriba, ángulo 0).
// Si numero es null (hubo un error), solo frena sin elegir casillero.
// Devuelve una promesa que se resuelve al terminar.
function detenerEn(numero) {
    cancelAnimationFrame(idFrame);

    // --- Destino de la rueda ---
    // El casillero i está en i·G grados. Si la rueda está girada A grados,
    // en pantalla aparece en i·G + A. Para que quede arriba (0°):
    //   i·G + A ≡ 0 (mód 360)  =>  A ≡ −i·G (mód 360)
    // Buscamos el primer ángulo con ese residuo que esté al menos
    // VUELTAS_FRENADO vueltas por delante del ángulo actual.
    const minimo = anguloRueda + VUELTAS_FRENADO * 360;
    let destinoRueda;
    if (numero === null) {
        destinoRueda = minimo;
    } else {
        const i = ORDEN_RUEDA.indexOf(numero);
        const residuo = modulo(-i * GRADOS_CASILLA, 360);
        destinoRueda = minimo + modulo(residuo - minimo, 360);
    }
    const recorridoRueda = destinoRueda - anguloRueda;

    // --- Destino de la bolita ---
    // Gira hacia atrás y debe terminar arriba (múltiplo de 360), justo sobre
    // el casillero ganador, que también estará arriba.
    const minimoBola = anguloBola - VUELTAS_FRENADO * 360;
    const destinoBola = minimoBola - modulo(minimoBola, 360);
    const recorridoBola = destinoBola - anguloBola; // negativo

    // Frenado "ease-out" cuadrático con la misma velocidad inicial que el giro
    // de la rueda, para que no se note el cambio: duración = 2 · recorrido / velocidad.
    const duracion = (2 * recorridoRueda) / VELOCIDAD;
    const ruedaInicio = anguloRueda;
    const bolaInicio = anguloBola;
    const inicio = performance.now();

    return new Promise((resolver) => {
        const paso = (ahora) => {
            const p = Math.min((ahora - inicio) / duracion, 1);
            const avance = 1 - (1 - p) * (1 - p);
            anguloRueda = ruedaInicio + recorridoRueda * avance;
            anguloBola = bolaInicio + recorridoBola * avance;

            // En el último 35 % la bolita baja de la pista al casillero.
            if (numero !== null) {
                const caida = Math.min(Math.max((p - 0.65) / 0.35, 0), 1);
                const suave = caida * caida * (3 - 2 * caida);
                radioBola = R_PISTA - (R_PISTA - R_BOLA_CASILLA) * suave;
            }
            aplicarTransformacion();

            if (p < 1) {
                idFrame = requestAnimationFrame(paso);
            } else {
                // Normalizar para que los números no crezcan sin límite.
                anguloRueda = modulo(destinoRueda, 360);
                anguloBola = modulo(destinoBola, 360);
                aplicarTransformacion();
                resolver();
            }
        };
        idFrame = requestAnimationFrame(paso);
    });
}

function esperar(ms) {
    return new Promise((resolver) => setTimeout(resolver, ms));
}

// =====================================================================
// Paño de apuestas
// Grilla: columna 1 = el 0; columnas 2..13 = números; columna 14 = "2 a 1".
// Fila 1: 3, 6, 9 … 36 · fila 2: 2, 5 … 35 · fila 3: 1, 4 … 34.
// Fila 4: docenas · fila 5: 1-18, par, rojo, negro, impar, 19-36.
// =====================================================================
function crearCasilla({ tipo, valor, texto, clases = "", columna, fila, html = null }) {
    const boton = document.createElement("button");
    boton.type = "button";
    boton.className = `rl-casilla-pano ${clases}`.trim();
    boton.dataset.tipo = tipo;
    boton.dataset.valor = String(valor);
    boton.dataset.clave = `${tipo}:${valor}`;
    boton.style.gridColumn = columna;
    boton.style.gridRow = fila;
    boton.setAttribute("aria-label", describir(tipo, valor));
    if (html) boton.appendChild(html);
    else boton.textContent = texto;
    pano.appendChild(boton);
}

function rombo(color) {
    const span = document.createElement("span");
    span.className = `rl-rombo ${color}`;
    return span;
}

function dibujarPano() {
    crearCasilla({ tipo: "pleno", valor: 0, texto: "0", clases: "verde", columna: "1", fila: "1 / 4" });

    for (let n = 1; n <= 36; n++) {
        const columna = Math.ceil(n / 3) + 1;
        const fila = n % 3 === 0 ? 1 : n % 3 === 2 ? 2 : 3;
        crearCasilla({ tipo: "pleno", valor: n, texto: String(n), clases: colorDe(n), columna: String(columna), fila: String(fila) });
    }

    // Columnas: la 3 queda arriba (fila de 3, 6, 9…), la 1 abajo.
    for (let c = 1; c <= 3; c++) {
        crearCasilla({ tipo: "columna", valor: c, texto: "2 a 1", clases: "exterior", columna: "14", fila: String(4 - c) });
    }

    for (let d = 1; d <= 3; d++) {
        const desde = 2 + (d - 1) * 4;
        crearCasilla({ tipo: "docena", valor: d, texto: `${d}ª docena`, clases: "exterior", columna: `${desde} / span 4`, fila: "4" });
    }

    const exteriores = [
        { tipo: "mitad", valor: "BAJA", texto: "1 a 18" },
        { tipo: "paridad", valor: "PAR", texto: "Par" },
        { tipo: "color", valor: "ROJO", html: rombo("rojo") },
        { tipo: "color", valor: "NEGRO", html: rombo("negro") },
        { tipo: "paridad", valor: "IMPAR", texto: "Impar" },
        { tipo: "mitad", valor: "ALTA", texto: "19 a 36" }
    ];
    exteriores.forEach((e, i) => {
        crearCasilla({ ...e, clases: "exterior", columna: `${2 + i * 2} / span 2`, fila: "5" });
    });
}

// ===== Manejo de apuestas (solo en memoria hasta pulsar Girar) =====
function totalApostado() {
    let total = 0;
    apuestas.forEach((a) => (total += a.cantidad));
    return total;
}

// Suma (o resta, si cantidad < 0) fichas en una casilla.
function sumarApuesta(clave, tipo, valor, cantidad) {
    const actual = apuestas.get(clave);
    const nueva = (actual ? actual.cantidad : 0) + cantidad;
    if (nueva <= 0) apuestas.delete(clave);
    else apuestas.set(clave, { tipo, valor, cantidad: nueva });
}

// Valores que se envían como número; el resto va como texto.
function convertirValor(tipo, valorTexto) {
    return ["pleno", "docena", "columna"].includes(tipo) ? Number(valorTexto) : valorTexto;
}

function limpiarResaltado() {
    pano.querySelectorAll(".ganadora, .acierto").forEach((c) => c.classList.remove("ganadora", "acierto"));
}

function pintarApuestas() {
    pano.querySelectorAll(".rl-casilla-pano").forEach((casilla) => {
        const apuesta = apuestas.get(casilla.dataset.clave);
        let ficha = casilla.querySelector(".rl-ficha-puesta");
        if (apuesta) {
            if (!ficha) {
                ficha = document.createElement("span");
                ficha.className = "rl-ficha-puesta";
                casilla.appendChild(ficha);
            }
            ficha.textContent = formatear(apuesta.cantidad);
        } else if (ficha) {
            ficha.remove();
        }
    });

    const total = totalApostado();
    textoTotal.textContent = formatear(total);
    actualizarBotones();
}

function ponerFicha(casilla) {
    if (ocupado) return;
    const tipo = casilla.dataset.tipo;
    const valor = convertirValor(tipo, casilla.dataset.valor);
    const clave = casilla.dataset.clave;

    if (!apuestas.has(clave) && apuestas.size >= MAX_APUESTAS) {
        mensajeError.textContent = `Máximo ${MAX_APUESTAS} apuestas distintas por giro.`;
        return;
    }

    limpiarResaltado();
    sumarApuesta(clave, tipo, valor, valorFicha);
    pilaDeshacer.push([{ clave, tipo, valor, cantidad: valorFicha }]);
    avisarSaldo();
    pintarApuestas();
}

// Aviso (no bloquea el clic): el servidor es quien valida de verdad.
function avisarSaldo() {
    mensajeError.textContent = totalApostado() > saldo ? MENSAJES_ERROR.SALDO_INSUFICIENTE : "";
}

function deshacer() {
    const ultima = pilaDeshacer.pop();
    if (!ultima) return;
    ultima.forEach((a) => sumarApuesta(a.clave, a.tipo, a.valor, -a.cantidad));
    avisarSaldo();
    pintarApuestas();
}

function limpiarApuestas() {
    apuestas = new Map();
    pilaDeshacer = [];
    mensajeError.textContent = "";
    pintarApuestas();
}

function repetirAnterior() {
    if (apuestasAnteriores.length === 0) return;
    limpiarResaltado();
    apuestas = new Map();
    const entrada = [];
    apuestasAnteriores.forEach((a) => {
        const clave = `${a.tipo}:${a.valor}`;
        sumarApuesta(clave, a.tipo, a.valor, a.cantidad);
        entrada.push({ clave, ...a });
    });
    pilaDeshacer = [entrada];
    avisarSaldo();
    pintarApuestas();
}

function elegirFicha(boton) {
    valorFicha = Number(boton.dataset.valor);
    botonesFicha.forEach((b) => b.setAttribute("aria-pressed", String(b === boton)));
}

// ===== Habilitar / deshabilitar controles =====
function actualizarBotones() {
    const hay = apuestas.size > 0;
    btnGirar.disabled = ocupado || !hay;
    btnDeshacer.disabled = ocupado || pilaDeshacer.length === 0;
    btnLimpiar.disabled = ocupado || !hay;
    btnRepetir.disabled = ocupado || apuestasAnteriores.length === 0;
    botonesFicha.forEach((b) => (b.disabled = ocupado));
    pano.querySelectorAll(".rl-casilla-pano").forEach((c) => (c.disabled = ocupado));
}

// ===== Llamada al servidor =====
async function llamarServidor(lista) {
    try {
        const { data, error } = await supabase.rpc("ruleta_girar", { p_apuestas: lista });

        if (error) {
            if (error.message?.includes("NO_AUTENTICADO")) {
                window.location.replace("../../login.html");
                return null;
            }
            mensajeError.textContent = traducirError(error);
            return null;
        }
        return data;
    } catch (error) {
        console.error(error);
        mensajeError.textContent = "No se pudo conectar con el servidor.";
        return null;
    }
}

// ===== Girar =====
async function girar() {
    if (ocupado) return; // evita dobles clics aunque el botón aún no se haya deshabilitado

    // Validación solo para dar aviso rápido; el servidor vuelve a validar todo.
    const lista = [...apuestas.values()].map((a) => ({ ...a }));
    const total = totalApostado();

    if (lista.length === 0 || lista.length > MAX_APUESTAS) {
        mensajeError.textContent = MENSAJES_ERROR.APUESTAS_INVALIDAS;
        return;
    }
    if (total > saldo) {
        mensajeError.textContent = MENSAJES_ERROR.SALDO_INSUFICIENTE;
        return;
    }

    ocupado = true;
    mensajeError.textContent = "";
    limpiarResaltado();
    listaDetalle.innerHTML = "";
    cajaTotales.hidden = true;
    numeroGrande.textContent = "?";
    numeroGrande.className = "rl-numero-grande";
    colorGrande.textContent = "Girando…";
    mostrarMensaje("No va más");
    actualizarBotones();
    empezarGiro();

    try {
        // Giro libre (≥ 1.2 s) + frenado (≥ 1 vuelta = 1.8 s) => al menos 3 s en total.
        const [respuesta] = await Promise.all([llamarServidor(lista), esperar(MS_GIRO_MINIMO)]);

        if (!respuesta) {
            // Error: la rueda frena sin resultado y las fichas siguen en el paño.
            await detenerEn(null);
            colorGrande.textContent = "Haz tu apuesta";
            mostrarMensaje("No se realizó el giro.", "pierde");
            return;
        }

        await detenerEn(respuesta.numero);
        mostrarResultado(respuesta);

        // Guardar para "Repetir" y quitar las fichas del paño.
        apuestasAnteriores = lista;
        apuestas = new Map();
        pilaDeshacer = [];
        pintarApuestas();

        cargarHistorial();
    } finally {
        ocupado = false;
        actualizarBotones();
    }
}

function mostrarResultado(r) {
    const numero = Number(r.numero);
    const color = colorDe(numero);
    mostrarSaldo(r.saldo);

    numeroGrande.textContent = numero;
    numeroGrande.className = `rl-numero-grande ${color}`;
    colorGrande.textContent = r.color; // ROJO / NEGRO / VERDE, tal como lo mandó el servidor

    // Resaltar en el paño la casilla del número y las apuestas que acertaron.
    const casillaNumero = pano.querySelector(`[data-clave="pleno:${numero}"]`);
    if (casillaNumero) casillaNumero.classList.add("ganadora");

    listaDetalle.innerHTML = "";
    r.apuestas.forEach((a) => {
        if (a.gano && a.tipo !== "pleno") {
            pano.querySelector(`[data-clave="${a.tipo}:${a.valor}"]`)?.classList.add("acierto");
        }
        const li = document.createElement("li");
        const nombre = document.createElement("span");
        nombre.textContent = `${describir(a.tipo, a.valor)} · ${formatear(a.cantidad)} tk`;
        const estado = document.createElement("span");
        estado.className = a.gano ? "gana" : "pierde";
        estado.textContent = a.gano ? "Ganó" : "Perdió";
        const premio = document.createElement("span");
        premio.className = a.gano ? "gana" : "pierde";
        premio.textContent = a.gano ? `+${formatear(a.premio)}` : "0";
        li.append(nombre, estado, premio);
        listaDetalle.appendChild(li);
    });

    const neta = Number(r.premio_total) - Number(r.apuesta_total);
    textoPremioTotal.textContent = formatear(r.premio_total);
    textoGananciaNeta.textContent = (neta > 0 ? "+" : "") + formatear(neta);
    textoGananciaNeta.className = neta > 0 ? "positivo" : neta < 0 ? "negativo" : "";
    cajaTotales.hidden = false;

    if (r.resultado === "GANADA") mostrarMensaje(`¡Ganaste +${formatear(neta)} tokens!`, "gana");
    else if (r.resultado === "EMPATE") mostrarMensaje("Recuperaste tu apuesta");
    else mostrarMensaje("Perdiste", "pierde");

    // Bolitas de la sesión (solo en memoria).
    numerosSesion.unshift(numero);
    numerosSesion = numerosSesion.slice(0, 10);
    pintarBolitas();
}

function pintarBolitas() {
    contBolitas.innerHTML = "";
    bolitasVacio.hidden = numerosSesion.length > 0;
    numerosSesion.forEach((n) => {
        const b = document.createElement("span");
        b.className = `rl-bolita ${colorDe(n)}`;
        b.textContent = n;
        contBolitas.appendChild(b);
    });
}

// ===== Historial (lectura directa: la política RLS solo deja ver lo propio) =====
let idJuego = null; // id de la Ruleta en el catálogo, se busca por nombre

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
        GANADA: { clase: "gana", texto: "Ganó" },
        EMPATE: { clase: "empate", texto: "Empate" },
        PERDIDA: { clase: "pierde", texto: "Perdió" }
    };

    data.forEach((partida) => {
        const info = ESTADOS[partida.resultado] || ESTADOS.PERDIDA;
        const li = document.createElement("li");

        const fecha = document.createElement("span");
        fecha.className = "fecha";
        fecha.textContent = new Date(partida.fecha_hora)
            .toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });

        const apuesta = document.createElement("span");
        apuesta.className = "monto";
        apuesta.title = "Apostado";
        apuesta.textContent = `${formatear(partida.apuesta)} tk`;

        const premio = document.createElement("span");
        premio.className = "monto " + info.clase;
        premio.title = "Premio";
        premio.textContent = `→ ${formatear(partida.premio)}`;

        const estado = document.createElement("span");
        estado.className = "estado " + info.clase;
        estado.textContent = info.texto;

        li.append(fecha, apuesta, premio, estado);
        historialLista.appendChild(li);
    });
}

// ===== Eventos =====
pano.addEventListener("click", (e) => {
    const casilla = e.target.closest(".rl-casilla-pano");
    if (casilla && !casilla.disabled) ponerFicha(casilla);
});
botonesFicha.forEach((b) => b.addEventListener("click", () => elegirFicha(b)));
btnDeshacer.addEventListener("click", deshacer);
btnLimpiar.addEventListener("click", limpiarApuestas);
btnRepetir.addEventListener("click", repetirAnterior);
btnGirar.addEventListener("click", girar);

// ===== Inicio: comprobar sesión, saldo e historial =====
async function iniciar() {
    const { data, error } = await supabase.auth.getUser();

    if (error || !data.user) {
        window.location.replace("../../login.html");
        return;
    }
    idUsuario = data.user.id;

    const { data: perfil, error: errorPerfil } = await supabase
        .from("usuario")
        .select("tokens")
        .eq("id_usuario", idUsuario)
        .single();

    if (errorPerfil) {
        console.error("Error al obtener perfil:", errorPerfil.message);
        mensajeError.textContent = MENSAJES_ERROR.PERFIL_NO_ENCONTRADO;
    } else {
        mostrarSaldo(perfil.tokens);
    }

    cargarHistorial();
}

dibujarRueda();
dibujarPano();
aplicarTransformacion();
pintarApuestas();
pintarBolitas();
iniciar();
