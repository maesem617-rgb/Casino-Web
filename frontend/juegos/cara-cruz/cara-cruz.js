// Cara o cruz: este archivo SOLO muestra lo que responde el servidor.
// La moneda se lanza y los tokens se mueven en la función cara_cruz_jugar
// de Supabase (ver supabase/migraciones/003_cara_cruz.sql).

import { supabase } from "../../js/supabase.js";

// ===== Elementos de la página =====
const saldoTokens = document.getElementById("saldoTokens");
// Ojo: no usar el id "moneda", ese es el <symbol> SVG del saldo.
const moneda = document.getElementById("monedaJuego");
const monedaSalto = document.getElementById("monedaSalto");
const sombra = document.getElementById("sombra");
const mensajeMesa = document.getElementById("mensajeMesa");
const mensajeError = document.getElementById("mensajeError");
const inputApuesta = document.getElementById("apuesta");
const fichasRapidas = document.querySelectorAll(".ficha-rapida[data-valor]");
const btnLimpiar = document.getElementById("limpiarApuesta");
const botonesLado = document.querySelectorAll(".lado-boton");
const btnLanzar = document.getElementById("btnLanzar");
const historialLista = document.getElementById("historialLista");
const historialVacio = document.getElementById("historialVacio");

// Debe coincidir con juego.nombre en la base de datos.
const NOMBRE_JUEGO = "Cara o cruz";

// ===== Estado local (solo para pintar; no decide nada) =====
let saldo = 0;
let eleccion = null;     // "CARA" o "CRUZ", lo que eligió el jugador
let ocupado = false;     // true mientras esperamos al servidor
let idUsuario = null;
let ladoVisible = "CARA"; // lado que muestra la moneda ahora mismo

// Los errores del servidor llegan como códigos; aquí se traducen al español.
// Mismos textos que en el Blackjack, más ELECCION_INVALIDA.
const MENSAJES_ERROR = {
    NO_AUTENTICADO: "Tu sesión expiró. Inicia sesión de nuevo.",
    PERFIL_NO_ENCONTRADO: "No se encontró tu perfil de jugador.",
    APUESTA_INVALIDA: "La apuesta debe ser un número entero mayor a 0.",
    SALDO_INSUFICIENTE: "No tienes tokens suficientes para esa apuesta.",
    ELECCION_INVALIDA: "Debes elegir cara o cruz.",
    JUEGO_NO_CONFIGURADO: "Cara o cruz no está registrado en el catálogo de juegos."
};

function traducirError(error) {
    const texto = error?.message || "";
    const codigo = Object.keys(MENSAJES_ERROR).find((c) => texto.includes(c));
    if (codigo) return MENSAJES_ERROR[codigo];
    // Si llega un decimal (ej. 10.5), Postgres no lo acepta como integer.
    if (texto.includes("type integer")) return MENSAJES_ERROR.APUESTA_INVALIDA;
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

// ===== Animación de la moneda =====
// Toda la animación se hace con requestAnimationFrame para que el paso de
// "girando" a "cayendo" sea continuo (sin saltos). El lado final lo decide
// el servidor: aquí solo se calcula hacia qué ángulo frenar.
const MS_POR_VUELTA = 400;              // velocidad del giro
const VELOCIDAD = 360 / MS_POR_VUELTA;  // grados por milisegundo
const ALTURA_SALTO = 60;                // px que sube la moneda
const MS_POR_SALTO = 600;

let angulo = 0;          // ángulo actual en grados (rotateY)
let altura = 0;          // px hacia arriba
let idFrame = null;

function aplicarTransformacion() {
    moneda.style.transform = `rotateY(${angulo}deg)`;
    monedaSalto.style.transform = `translateY(${-altura}px)`;
    const escala = 1 - (altura / ALTURA_SALTO) * 0.4;
    sombra.style.transform = `scale(${escala})`;
    sombra.style.opacity = String(0.5 + escala * 0.5);
}

function empezarGiro() {
    cancelAnimationFrame(idFrame);
    const inicio = performance.now();
    const anguloInicio = angulo;

    const paso = (ahora) => {
        const t = ahora - inicio;
        angulo = anguloInicio + t * VELOCIDAD;
        altura = Math.abs(Math.sin((t / MS_POR_SALTO) * Math.PI)) * ALTURA_SALTO;
        aplicarTransformacion();
        idFrame = requestAnimationFrame(paso);
    };
    idFrame = requestAnimationFrame(paso);
}

// Frena la moneda para que quede mostrando `lado`. Devuelve una promesa
// que se resuelve cuando la moneda termina de caer.
function detenerEn(lado) {
    cancelAnimationFrame(idFrame);

    // CARA se ve en 0°, CRUZ en 180° (módulo 360).
    // Buscamos el primer ángulo con ese lado que esté al menos una vuelta adelante.
    const destinoBase = lado === "CRUZ" ? 180 : 0;
    const destino = Math.ceil((angulo + 360 - destinoBase) / 360) * 360 + destinoBase;
    const recorrido = destino - angulo;

    // Frenado "ease-out" cuadrático, con la misma velocidad inicial que el giro
    // para que no se note el cambio: duración = 2 · recorrido / velocidad.
    const duracion = (2 * recorrido) / VELOCIDAD;
    const anguloInicio = angulo;
    const alturaInicio = altura;
    const inicio = performance.now();

    return new Promise((resolver) => {
        const paso = (ahora) => {
            const p = Math.min((ahora - inicio) / duracion, 1);
            const avance = 1 - (1 - p) * (1 - p);
            angulo = anguloInicio + recorrido * avance;
            altura = alturaInicio * (1 - avance);
            aplicarTransformacion();

            if (p < 1) {
                idFrame = requestAnimationFrame(paso);
            } else {
                // Normalizar para que el número no crezca sin límite.
                angulo = destino % 360;
                aplicarTransformacion();
                ladoVisible = lado;
                resolver();
            }
        };
        idFrame = requestAnimationFrame(paso);
    });
}

function esperar(ms) {
    return new Promise((resolver) => setTimeout(resolver, ms));
}

// ===== Habilitar / deshabilitar controles =====
function actualizarBotones() {
    btnLanzar.disabled = ocupado || !eleccion;
    inputApuesta.disabled = ocupado;
    btnLimpiar.disabled = ocupado;
    fichasRapidas.forEach((f) => (f.disabled = ocupado));
    botonesLado.forEach((b) => (b.disabled = ocupado));
}

function elegirLado(lado) {
    eleccion = lado;
    botonesLado.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lado === lado)));
    mensajeError.textContent = "";
    actualizarBotones();
}

// ===== Llamada al servidor =====
async function llamarServidor(apuesta) {
    try {
        const { data, error } = await supabase.rpc("cara_cruz_jugar", {
            p_apuesta: apuesta,
            p_eleccion: eleccion
        });

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

// ===== Lanzar =====
async function lanzar() {
    if (ocupado) return; // evita dobles clics aunque el botón aún no se haya deshabilitado

    // Validación solo para dar aviso rápido; el servidor vuelve a validar todo.
    const apuesta = Number(inputApuesta.value);

    if (!eleccion) {
        mensajeError.textContent = MENSAJES_ERROR.ELECCION_INVALIDA;
        return;
    }
    if (!Number.isInteger(apuesta) || apuesta <= 0) {
        mensajeError.textContent = MENSAJES_ERROR.APUESTA_INVALIDA;
        return;
    }
    if (apuesta > saldo) {
        mensajeError.textContent = MENSAJES_ERROR.SALDO_INSUFICIENTE;
        return;
    }

    ocupado = true;
    mensajeError.textContent = "";
    mostrarMensaje("Lanzando…");
    actualizarBotones();
    empezarGiro();

    try {
        // La moneda gira al menos 1.5 s aunque el servidor responda antes.
        const [respuesta] = await Promise.all([llamarServidor(apuesta), esperar(1500)]);

        if (!respuesta) {
            // Error: la moneda vuelve al lado que mostraba y no hay resultado.
            await detenerEn(ladoVisible);
            mostrarMensaje("Elige cara o cruz, tu apuesta y pulsa Lanzar.");
            return;
        }

        await detenerEn(respuesta.resultado);
        mostrarSaldo(respuesta.saldo);

        const ladoTexto = respuesta.resultado === "CARA" ? "Cara" : "Cruz";
        if (respuesta.gano) {
            const ganancia = Number(respuesta.premio) - Number(respuesta.apuesta);
            mostrarMensaje(`${ladoTexto} · ¡Ganaste +${formatear(ganancia)} tokens!`, "gana");
        } else {
            mostrarMensaje(`${ladoTexto} · Perdiste`, "pierde");
        }

        cargarHistorial();
    } finally {
        ocupado = false;
        actualizarBotones();
    }
}

// ===== Historial (lectura directa: la política RLS solo deja ver lo propio) =====
let idJuego = null; // id de Cara o cruz en el catálogo, se busca por nombre

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
        .select("fecha_hora, apuesta, resultado")
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

    data.forEach((partida) => {
        const gano = partida.resultado === "GANADA";
        const li = document.createElement("li");

        const fecha = document.createElement("span");
        fecha.className = "fecha";
        fecha.textContent = new Date(partida.fecha_hora)
            .toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });

        const monto = document.createElement("span");
        monto.className = "monto";
        monto.textContent = `${formatear(partida.apuesta)} tk`;

        const estado = document.createElement("span");
        estado.className = "estado " + (gano ? "gana" : "pierde");
        estado.textContent = gano ? "Ganó" : "Perdió";

        li.append(fecha, monto, estado);
        historialLista.appendChild(li);
    });
}

// ===== Eventos =====
fichasRapidas.forEach((ficha) => {
    ficha.addEventListener("click", () => {
        const actual = Number(inputApuesta.value) || 0;
        inputApuesta.value = actual + Number(ficha.dataset.valor);
    });
});
btnLimpiar.addEventListener("click", () => (inputApuesta.value = ""));
botonesLado.forEach((b) => b.addEventListener("click", () => elegirLado(b.dataset.lado)));
btnLanzar.addEventListener("click", lanzar);

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

    aplicarTransformacion();
    actualizarBotones();
    cargarHistorial();
}

iniciar();
