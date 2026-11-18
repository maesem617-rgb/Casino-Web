// Blackjack: este archivo SOLO muestra lo que responde el servidor.
// El mazo, el resultado y los tokens se deciden en las funciones
// blackjack_* de Supabase (ver supabase/migraciones/002_blackjack.sql).

import { supabase } from "../../js/supabase.js";

// ===== Elementos de la página =====
const saldoTokens = document.getElementById("saldoTokens");
const cartasCrupier = document.getElementById("cartasCrupier");
const cartasJugador = document.getElementById("cartasJugador");
const totalCrupier = document.getElementById("totalCrupier");
const totalJugador = document.getElementById("totalJugador");
const mensajeMesa = document.getElementById("mensajeMesa");
const mensajeError = document.getElementById("mensajeError");
const inputApuesta = document.getElementById("apuesta");
const fichasRapidas = document.querySelectorAll(".ficha-rapida[data-valor]");
const btnLimpiar = document.getElementById("limpiarApuesta");
const btnRepartir = document.getElementById("btnRepartir");
const btnPedir = document.getElementById("btnPedir");
const btnPlantarse = document.getElementById("btnPlantarse");
const btnDoblar = document.getElementById("btnDoblar");

// ===== Estado local (solo para pintar; no decide nada) =====
let mano = null;         // última respuesta del servidor
let saldo = 0;
let ocupado = false;     // true mientras esperamos al servidor
let manoPintada = null;  // id de la mano dibujada, para animar solo cartas nuevas
let cartasVistasJugador = 0;
let cartasVistasCrupier = 0;

const SIMBOLOS = { picas: "♠", corazones: "♥", diamantes: "♦", treboles: "♣" };

// Los errores del servidor llegan como códigos; aquí se traducen al español.
const MENSAJES_ERROR = {
    NO_AUTENTICADO: "Tu sesión expiró. Inicia sesión de nuevo.",
    PERFIL_NO_ENCONTRADO: "No se encontró tu perfil de jugador.",
    APUESTA_INVALIDA: "La apuesta debe ser un número entero mayor a 0.",
    SALDO_INSUFICIENTE: "No tienes tokens suficientes para esa apuesta.",
    MANO_NO_ENCONTRADA: "No se encontró la mano. Recarga la página.",
    MANO_TERMINADA: "Esa mano ya terminó.",
    NO_PUEDE_DOBLAR: "Solo puedes doblar con tus dos primeras cartas.",
    JUEGO_NO_CONFIGURADO: "El Blackjack no está registrado en el catálogo de juegos."
};

const MENSAJES_RESULTADO = {
    BLACKJACK: { texto: "¡Blackjack!", clase: "gana" },
    GANADA: { texto: "Ganaste", clase: "gana" },
    EMPATE: { texto: "Empate", clase: "empate" },
    PASADO: { texto: "Te pasaste", clase: "pierde" },
    PERDIDA: { texto: "Perdiste", clase: "pierde" }
};

function traducirError(error) {
    const texto = error?.message || "";
    const codigo = Object.keys(MENSAJES_ERROR).find((c) => texto.includes(c));
    if (codigo) return MENSAJES_ERROR[codigo];
    console.error("Error del servidor:", error);
    return "Ocurrió un error inesperado. Intenta de nuevo.";
}

// ===== Llamada genérica a una función RPC =====
async function llamarServidor(nombreFuncion, parametros = {}) {
    ocupado = true;
    mensajeError.textContent = "";
    actualizarBotones();

    try {
        const { data, error } = await supabase.rpc(nombreFuncion, parametros);

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
    } finally {
        ocupado = false;
        actualizarBotones();
    }
}

// ===== Dibujo de cartas =====
function crearCarta(carta, esNueva, retraso) {
    const div = document.createElement("div");

    if (!carta) {
        div.className = "carta dorso";
    } else {
        const simbolo = SIMBOLOS[carta.palo] || "?";
        const esRoja = carta.palo === "corazones" || carta.palo === "diamantes";
        div.className = "carta" + (esRoja ? " roja" : "");
        div.setAttribute("aria-label", `${carta.valor} de ${carta.palo}`);
        div.innerHTML = `
            <span class="esquina sup">${carta.valor}<span>${simbolo}</span></span>
            <span class="centro">${simbolo}</span>
            <span class="esquina inf">${carta.valor}<span>${simbolo}</span></span>`;
    }

    if (esNueva) {
        div.classList.add("nueva");
        div.style.animationDelay = `${retraso}s`;
    }
    return div;
}

// Pinta una fila de cartas. Solo anima las que no se habían mostrado antes.
function pintarFila(contenedor, cartas, yaVistas, conDorso, retrasoInicial) {
    contenedor.innerHTML = "";
    let retraso = retrasoInicial;

    cartas.forEach((carta, i) => {
        const esNueva = i >= yaVistas;
        contenedor.appendChild(crearCarta(carta, esNueva, esNueva ? retraso : 0));
        if (esNueva) retraso += 0.18;
    });

    if (conDorso) {
        const dorsoNuevo = yaVistas === 0;
        contenedor.appendChild(crearCarta(null, dorsoNuevo, retraso));
        if (dorsoNuevo) retraso += 0.18;
    }
    return retraso;
}

function limpiarMesa() {
    cartasCrupier.innerHTML = "";
    cartasJugador.innerHTML = "";
    totalCrupier.textContent = "";
    totalJugador.textContent = "";
    manoPintada = null;
    cartasVistasJugador = 0;
    cartasVistasCrupier = 0;
}

function mostrarMensaje(texto, clase = "") {
    mensajeMesa.textContent = texto;
    mensajeMesa.className = "mensaje-mesa" + (clase ? " " + clase : "");
}

function mostrarSaldo(valor) {
    saldo = Number(valor) || 0;
    saldoTokens.textContent = saldo.toLocaleString("es-MX");
}

// ===== Pinta toda la respuesta del servidor =====
function pintarMano(respuesta) {
    mano = respuesta;
    mostrarSaldo(respuesta.saldo);

    if (respuesta.estado === "sin_mano") {
        actualizarBotones();
        return;
    }

    if (manoPintada !== respuesta.id_mano) {
        limpiarMesa();
        manoPintada = respuesta.id_mano;
    }

    const jugador = respuesta.cartas_jugador || [];
    const crupier = respuesta.cartas_crupier || [];

    let retraso = pintarFila(cartasJugador, jugador, cartasVistasJugador, false, 0);
    pintarFila(cartasCrupier, crupier, cartasVistasCrupier, respuesta.crupier_oculta, retraso);

    cartasVistasJugador = jugador.length;
    cartasVistasCrupier = crupier.length;

    totalJugador.textContent = respuesta.total_jugador;
    totalCrupier.textContent = respuesta.crupier_oculta
        ? `${respuesta.total_crupier} + ?`
        : respuesta.total_crupier;

    if (respuesta.estado === "terminada") {
        const info = MENSAJES_RESULTADO[respuesta.resultado] || { texto: "Mano terminada", clase: "" };
        const premio = Number(respuesta.premio) || 0;
        const textoPremio = premio > 0
            ? ` · Premio: ${premio.toLocaleString("es-MX")} tokens`
            : ` · Apostaste ${Number(respuesta.apuesta).toLocaleString("es-MX")} tokens`;
        mostrarMensaje(info.texto + textoPremio, info.clase);
    } else {
        mostrarMensaje(`En juego · Apuesta: ${Number(respuesta.apuesta).toLocaleString("es-MX")} tokens`);
    }

    actualizarBotones();
}

// ===== Habilitar / deshabilitar botones según el estado =====
function actualizarBotones() {
    const enJuego = mano?.estado === "en_juego";

    btnRepartir.disabled = ocupado || enJuego;
    inputApuesta.disabled = ocupado || enJuego;
    fichasRapidas.forEach((f) => (f.disabled = ocupado || enJuego));
    btnLimpiar.disabled = ocupado || enJuego;

    btnPedir.disabled = ocupado || !enJuego;
    btnPlantarse.disabled = ocupado || !enJuego;
    btnDoblar.disabled = ocupado || !enJuego || !mano?.puede_doblar;
}

// ===== Acciones del jugador =====
async function repartir() {
    // Validación solo para dar aviso rápido; el servidor vuelve a validar todo.
    const apuesta = Number(inputApuesta.value);

    if (!Number.isInteger(apuesta) || apuesta <= 0) {
        mensajeError.textContent = MENSAJES_ERROR.APUESTA_INVALIDA;
        return;
    }
    if (apuesta > saldo) {
        mensajeError.textContent = MENSAJES_ERROR.SALDO_INSUFICIENTE;
        return;
    }

    limpiarMesa();
    const respuesta = await llamarServidor("blackjack_iniciar", { p_apuesta: apuesta });
    if (respuesta) pintarMano(respuesta);
}

async function accionEnMano(nombreFuncion) {
    if (!mano?.id_mano) return;
    const respuesta = await llamarServidor(nombreFuncion, { p_id_mano: mano.id_mano });
    if (respuesta) pintarMano(respuesta);
}

fichasRapidas.forEach((ficha) => {
    ficha.addEventListener("click", () => {
        const actual = Number(inputApuesta.value) || 0;
        inputApuesta.value = actual + Number(ficha.dataset.valor);
    });
});
btnLimpiar.addEventListener("click", () => (inputApuesta.value = ""));
btnRepartir.addEventListener("click", repartir);
btnPedir.addEventListener("click", () => accionEnMano("blackjack_pedir"));
btnPlantarse.addEventListener("click", () => accionEnMano("blackjack_plantarse"));
btnDoblar.addEventListener("click", () => accionEnMano("blackjack_doblar"));

// ===== Inicio: comprobar sesión y reanudar mano si existe =====
async function iniciar() {
    const { data, error } = await supabase.auth.getUser();

    if (error || !data.user) {
        window.location.replace("../../login.html");
        return;
    }

    const respuesta = await llamarServidor("blackjack_mano_actual");
    if (!respuesta) return;

    pintarMano(respuesta);
    if (respuesta.estado === "en_juego") {
        mostrarMensaje(`Reanudamos tu mano · Apuesta: ${Number(respuesta.apuesta).toLocaleString("es-MX")} tokens`);
    }
}

iniciar();
