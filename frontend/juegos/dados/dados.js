// Dados "7 arriba, 7 abajo": este archivo SOLO arma las apuestas, anima y
// muestra lo que responde el servidor. Los dados se tiran y los tokens se
// mueven en la función dados_tirar de Supabase
// (ver supabase/migraciones/007_dados.sql).

import { supabase } from "../../js/supabase.js";

// ===== Elementos de la página (todos los ids propios empiezan con "dd") =====
const saldoTokens = document.getElementById("saldoTokens");
const fieltro = document.getElementById("ddFieltro");
const sumaGrande = document.getElementById("ddSumaGrande");
const doblesAviso = document.getElementById("ddDoblesAviso");
const mensajeMesa = document.getElementById("ddMensaje");
const listaDetalle = document.getElementById("ddDetalle");
const cajaTotales = document.getElementById("ddTotales");
const textoPremioTotal = document.getElementById("ddPremioTotal");
const textoGananciaNeta = document.getElementById("ddGananciaNeta");
const listaTiradas = document.getElementById("ddTiradas");
const tiradasVacio = document.getElementById("ddTiradasVacio");
const historialLista = document.getElementById("ddHistorialLista");
const historialVacio = document.getElementById("ddHistorialVacio");
const pano = document.getElementById("ddPano");
const botonesFicha = document.querySelectorAll(".dd-ficha-valor");
const mensajeError = document.getElementById("ddError");
const textoTotal = document.getElementById("ddTotalApostado");
const btnDeshacer = document.getElementById("ddDeshacer");
const btnLimpiar = document.getElementById("ddLimpiar");
const btnRepetir = document.getElementById("ddRepetir");
const btnTirar = document.getElementById("ddTirar");

// Debe coincidir con juego.nombre en la base de datos.
const NOMBRE_JUEGO = "Dados";
const MAX_APUESTAS = 15; // el servidor también lo valida

// Pagos SOLO para mostrarlos en el paño. Quien paga de verdad es el servidor.
const PAGO_SUMA = { 2: 30, 3: 15, 4: 10, 5: 7, 6: 6, 8: 6, 9: 7, 10: 10, 11: 15, 12: 30 };

// Caracteres Unicode de las caras del dado: ⚀ ⚁ ⚂ ⚃ ⚄ ⚅ (índice = valor - 1).
const CARAS_UNICODE = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

// ===== Estado local (solo para pintar; no decide nada) =====
let saldo = 0;
let idUsuario = null;
let ocupado = false;              // true mientras esperamos al servidor y dura la animación
let valorFicha = 10;
// Apuestas puestas en el paño: clave "tipo:valor" -> { tipo, valor, cantidad }
// (valor es null en todo lo que no sea "suma").
let apuestas = new Map();
// Cada clic (o "Repetir") deja una entrada para poder deshacerla:
// una lista de { clave, tipo, valor, cantidad } que se sumaron.
let pilaDeshacer = [];
let apuestasAnteriores = [];      // lo último que se envió con éxito
let tiradasSesion = [];           // últimas 10 tiradas { dado1, dado2, suma } (en memoria)

// Los errores del servidor llegan como códigos; aquí se traducen al español.
// Mismos códigos y textos que en la Ruleta.
const MENSAJES_ERROR = {
    NO_AUTENTICADO: "Tu sesión expiró. Inicia sesión de nuevo.",
    PERFIL_NO_ENCONTRADO: "No se encontró tu perfil de jugador.",
    APUESTAS_INVALIDAS: `Debes poner entre 1 y ${MAX_APUESTAS} apuestas distintas.`,
    APUESTA_INVALIDA: "Hay una apuesta inválida: revisa el tipo, el valor y que la cantidad sea un entero mayor a 0.",
    SALDO_INSUFICIENTE: "No tienes tokens suficientes para esa apuesta.",
    JUEGO_NO_CONFIGURADO: "Los Dados no están registrados en el catálogo de juegos."
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

function claveDe(tipo, valor) {
    return `${tipo}:${valor ?? ""}`;
}

// Texto corto para una apuesta: "Bajo (2–6)", "Suma 11"...
function describir(tipo, valor) {
    switch (tipo) {
        case "bajo": return "Bajo (2–6)";
        case "siete": return "Siete";
        case "alto": return "Alto (8–12)";
        case "dobles": return "Dobles";
        case "suma": return `Suma ${valor}`;
        default: return tipo;
    }
}

function esperar(ms) {
    return new Promise((resolver) => setTimeout(resolver, ms));
}

// =====================================================================
// Dados 3D
// Cada cubo tiene 6 caras. En CSS (dados.css) cada cara está girada hacia
// su lado: 1 al frente, 6 atrás, 3 a la derecha, 4 a la izquierda,
// 2 arriba y 5 abajo. Para que se vea el valor V, hay que girar el CUBO
// de modo que la cara V quede mirando al frente (hacia nosotros):
// =====================================================================
const ROTACION_CARA = {
    1: { x: 0, y: 0 },     // ya está al frente
    2: { x: -90, y: 0 },   // la de arriba baja al frente
    3: { x: 0, y: -90 },   // la de la derecha gira hacia el frente
    4: { x: 0, y: 90 },    // la de la izquierda gira hacia el frente
    5: { x: 90, y: 0 },    // la de abajo sube al frente
    6: { x: 0, y: 180 }    // la de atrás da media vuelta
};

// Qué puntos lleva cada cara (posiciones de la grilla 3x3 en dados.css).
const PUNTOS_CARA = {
    1: ["c"],
    2: ["ai", "bd"],
    3: ["ai", "c", "bd"],
    4: ["ai", "ad", "bi", "bd"],
    5: ["ai", "ad", "c", "bi", "bd"],
    6: ["ai", "mi", "bi", "ad", "md", "bd"]
};

// Cada dado gira distinto para que no se vean idénticos:
// otra cantidad de vueltas, otro sentido, otra duración y otros rebotes.
const ESTILO_DADO = [
    { vueltasX: 3, vueltasY: 2, sentidoX: 1, sentidoY: 1, duracion: 1700, desde: -330, alturas: [170, 70, 22] },
    { vueltasX: 2, vueltasY: 3, sentidoX: -1, sentidoY: 1, duracion: 1950, desde: -420, alturas: [140, 85, 30] }
];

// Por cada dado guardamos sus 3 capas y la rotación en la que quedó.
const dados = [];

function crearDado(indice, valorInicial) {
    const carril = document.createElement("div");
    carril.className = `dd-carril ${indice === 0 ? "dd-uno" : "dd-dos"}`;

    const sombra = document.createElement("div");
    sombra.className = "dd-sombra";

    const salto = document.createElement("div");
    salto.className = "dd-salto";

    const cubo = document.createElement("div");
    cubo.className = "dd-cubo";

    for (let valor = 1; valor <= 6; valor++) {
        const cara = document.createElement("div");
        cara.className = `dd-cara dd-cara-${valor}`;
        PUNTOS_CARA[valor].forEach((pos) => {
            const punto = document.createElement("span");
            punto.className = `dd-punto dd-p-${pos}`;
            cara.appendChild(punto);
        });
        cubo.appendChild(cara);
    }

    salto.appendChild(cubo);
    carril.append(sombra, salto);
    fieltro.appendChild(carril);

    // Pose inicial: un poco inclinado para que se note que es 3D.
    const rot = ROTACION_CARA[valorInicial];
    const dado = { carril, sombra, salto, cubo, x: rot.x, y: rot.y, z: indice === 0 ? -12 : 10 };
    aplicarRotacion(dado);
    dados.push(dado);
}

function transformCubo(x, y, z) {
    // El orden importa: primero se gira en Y, luego en X y al final en Z
    // (CSS aplica las funciones de derecha a izquierda). rotateZ solo inclina
    // el dado sobre la mesa; no cambia qué cara queda al frente.
    return `rotateZ(${z}deg) rotateX(${x}deg) rotateY(${y}deg)`;
}

function aplicarRotacion(dado) {
    dado.cubo.style.transform = transformCubo(dado.x, dado.y, dado.z);
}

// Anima un dado hasta que muestre `valor` (el que mandó el servidor).
function rodarDado(dado, estilo, valor) {
    const destino = ROTACION_CARA[valor];
    // Se suman vueltas completas (360°): no cambian la cara final, solo hacen
    // que el dado dé varias vueltas en el camino. El navegador interpola cada
    // ángulo por separado, así que de 0° a 810° sí da dos vueltas y cuarto.
    // Un extra al azar (0 o 1 vuelta) hace que cada tirada se vea distinta;
    // es solo decorativo: el valor ya lo decidió el servidor.
    const extraX = Math.round(Math.random());
    const extraY = Math.round(Math.random());
    const xFinal = destino.x + 360 * (estilo.vueltasX + extraX) * estilo.sentidoX;
    const yFinal = destino.y + 360 * (estilo.vueltasY + extraY) * estilo.sentidoY;
    const zFinal = Math.round(Math.random() * 24 - 12); // inclinación final de -12° a 12°

    const d = estilo.duracion;
    const [h1, h2, h3] = estilo.alturas;
    const opciones = { duration: d, fill: "forwards" };

    // 1) Giro: rápido al inicio y frena al final.
    const giro = dado.cubo.animate([
        { transform: transformCubo(dado.x, dado.y, dado.z) },
        { transform: transformCubo(xFinal, yFinal, zFinal) }
    ], { ...opciones, easing: "cubic-bezier(.15, .6, .25, 1)" });

    // 2) Avance: entra rodando desde la izquierda.
    dado.carril.animate([
        { transform: `translateX(${estilo.desde}px)` },
        { transform: "translateX(0)" }
    ], { ...opciones, easing: "cubic-bezier(.2, .7, .3, 1)" });

    // 3) Rebotes: cae, rebota cada vez más bajo y se queda quieto.
    //    "ease-in" al caer (acelera) y "ease-out" al subir (frena), como la gravedad.
    const rebotes = [
        { y: -h1, offset: 0, easing: "ease-in" },
        { y: 0, offset: 0.34, easing: "ease-out" },
        { y: -h2, offset: 0.52, easing: "ease-in" },
        { y: 0, offset: 0.7, easing: "ease-out" },
        { y: -h3, offset: 0.8, easing: "ease-in" },
        { y: 0, offset: 0.9 },
        { y: 0, offset: 1 }
    ];
    dado.salto.animate(
        rebotes.map((r) => ({ transform: `translateY(${r.y}px)`, offset: r.offset, easing: r.easing || "linear" })),
        opciones
    );

    // La sombra se achica y se aclara cuando el dado está en el aire.
    dado.sombra.animate(
        rebotes.map((r) => {
            const alto = -r.y / h1; // 0 en el piso, 1 en lo más alto
            return { transform: `scale(${1 - 0.5 * alto})`, opacity: 0.8 - 0.55 * alto, offset: r.offset, easing: r.easing || "linear" };
        }),
        opciones
    );

    return giro.finished.then(() => {
        // Guardar la rotación SIN las vueltas extra (es la misma orientación),
        // fijarla en el estilo y quitar las animaciones para que no se acumulen.
        dado.x = destino.x;
        dado.y = destino.y;
        dado.z = zFinal;
        aplicarRotacion(dado);
        [dado.cubo, dado.carril, dado.salto, dado.sombra].forEach((el) =>
            el.getAnimations().forEach((a) => a.cancel()));
    });
}

function agitarDados(si) {
    fieltro.classList.toggle("dd-agitando", si);
}

// =====================================================================
// Paño de apuestas
// 10 columnas. Fila 1: BAJO · SIETE · ALTO. Fila 2: DOBLES.
// Fila 3: sumas exactas 2–6 y 8–12.
// =====================================================================
function crearCasilla({ tipo, valor = null, nombre, rango = "", pago, clases = "", columna, fila }) {
    const boton = document.createElement("button");
    boton.type = "button";
    boton.className = `dd-casilla ${clases}`.trim();
    boton.dataset.tipo = tipo;
    boton.dataset.valor = valor === null ? "" : String(valor);
    boton.dataset.clave = claveDe(tipo, valor);
    boton.style.gridColumn = columna;
    boton.style.gridRow = fila;
    boton.setAttribute("aria-label", `${describir(tipo, valor)}, paga ×${pago}`);

    const textoNombre = document.createElement("span");
    textoNombre.className = "dd-casilla-nombre";
    textoNombre.textContent = nombre;
    boton.appendChild(textoNombre);

    if (rango) {
        const textoRango = document.createElement("span");
        textoRango.className = "dd-casilla-rango";
        textoRango.textContent = rango;
        boton.appendChild(textoRango);
    }

    const textoPago = document.createElement("span");
    textoPago.className = "dd-casilla-pago";
    textoPago.textContent = `×${pago}`;
    boton.appendChild(textoPago);

    pano.appendChild(boton);
}

function dibujarPano() {
    crearCasilla({ tipo: "bajo", nombre: "Bajo", rango: "suma 2 a 6", pago: 2, clases: "dd-grande", columna: "1 / span 4", fila: "1" });
    crearCasilla({ tipo: "siete", nombre: "Siete", rango: "suma 7", pago: 5, clases: "dd-grande dd-siete", columna: "5 / span 2", fila: "1" });
    crearCasilla({ tipo: "alto", nombre: "Alto", rango: "suma 8 a 12", pago: 2, clases: "dd-grande", columna: "7 / span 4", fila: "1" });

    crearCasilla({ tipo: "dobles", nombre: "Dobles", rango: "los dos dados iguales", pago: 5, columna: "1 / span 10", fila: "2" });

    const sumas = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12];
    sumas.forEach((n, i) => {
        crearCasilla({ tipo: "suma", valor: n, nombre: String(n), pago: PAGO_SUMA[n], clases: "dd-numero", columna: String(i + 1), fila: "3" });
    });
}

// ===== Manejo de apuestas (solo en memoria hasta pulsar Tirar) =====
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

// Lo que se envía al servidor: "valor" solo va en las apuestas de suma
// (el servidor rechaza "valor" en los demás tipos).
function paraEnviar(a) {
    return a.tipo === "suma"
        ? { tipo: a.tipo, valor: a.valor, cantidad: a.cantidad }
        : { tipo: a.tipo, cantidad: a.cantidad };
}

function limpiarResaltado() {
    pano.querySelectorAll(".dd-ganadora").forEach((c) => c.classList.remove("dd-ganadora"));
}

function pintarApuestas() {
    pano.querySelectorAll(".dd-casilla").forEach((casilla) => {
        const apuesta = apuestas.get(casilla.dataset.clave);
        let ficha = casilla.querySelector(".dd-ficha-puesta");
        if (apuesta) {
            if (!ficha) {
                ficha = document.createElement("span");
                ficha.className = "dd-ficha-puesta";
                casilla.appendChild(ficha);
            }
            ficha.textContent = formatear(apuesta.cantidad);
        } else if (ficha) {
            ficha.remove();
        }
    });

    textoTotal.textContent = formatear(totalApostado());
    actualizarBotones();
}

function ponerFicha(casilla) {
    if (ocupado) return;
    const tipo = casilla.dataset.tipo;
    const valor = casilla.dataset.valor === "" ? null : Number(casilla.dataset.valor);
    const clave = casilla.dataset.clave;

    if (!apuestas.has(clave) && apuestas.size >= MAX_APUESTAS) {
        mensajeError.textContent = `Máximo ${MAX_APUESTAS} apuestas distintas por tirada.`;
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
        const valor = a.valor ?? null;
        const clave = claveDe(a.tipo, valor);
        sumarApuesta(clave, a.tipo, valor, a.cantidad);
        entrada.push({ clave, tipo: a.tipo, valor, cantidad: a.cantidad });
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
    btnTirar.disabled = ocupado || !hay;
    btnDeshacer.disabled = ocupado || pilaDeshacer.length === 0;
    btnLimpiar.disabled = ocupado || !hay;
    btnRepetir.disabled = ocupado || apuestasAnteriores.length === 0;
    botonesFicha.forEach((b) => (b.disabled = ocupado));
    pano.querySelectorAll(".dd-casilla").forEach((c) => (c.disabled = ocupado));
}

// ===== Llamada al servidor =====
async function llamarServidor(lista) {
    try {
        const { data, error } = await supabase.rpc("dados_tirar", { p_apuestas: lista });

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

// ===== Tirar =====
const MS_AGITAR_MINIMO = 350; // los dados tiemblan al menos esto antes de rodar

async function tirar() {
    if (ocupado) return; // evita dobles clics aunque el botón aún no se haya deshabilitado

    // Validación solo para dar aviso rápido; el servidor vuelve a validar todo.
    const lista = [...apuestas.values()].map(paraEnviar);
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
    doblesAviso.hidden = true;
    sumaGrande.textContent = "?";
    sumaGrande.className = "dd-suma-grande";
    mostrarMensaje("No va más");
    actualizarBotones();
    agitarDados(true);

    try {
        // Primero llega la respuesta (los dados tiemblan mientras tanto);
        // luego ruedan ~1.7–1.95 s y caen en los valores que mandó el servidor.
        const [respuesta] = await Promise.all([llamarServidor(lista), esperar(MS_AGITAR_MINIMO)]);
        agitarDados(false);

        if (!respuesta) {
            // Error: no se tiró nada y las fichas siguen en el paño.
            mostrarMensaje("No se realizó la tirada.", "pierde");
            return;
        }

        mostrarMensaje("¡Rodando!");
        await Promise.all([
            rodarDado(dados[0], ESTILO_DADO[0], Number(respuesta.dado1)),
            rodarDado(dados[1], ESTILO_DADO[1], Number(respuesta.dado2))
        ]);
        mostrarResultado(respuesta);

        // Guardar para "Repetir" y quitar las fichas del paño.
        apuestasAnteriores = lista;
        apuestas = new Map();
        pilaDeshacer = [];
        pintarApuestas();

        cargarHistorial();
    } finally {
        agitarDados(false);
        ocupado = false;
        actualizarBotones();
    }
}

function mostrarResultado(r) {
    const suma = Number(r.suma);
    mostrarSaldo(r.saldo);

    sumaGrande.textContent = suma;
    const zona = suma === 7 ? "dd-siete" : suma <= 6 ? "dd-bajo" : "dd-alto";
    sumaGrande.className = `dd-suma-grande ${zona}`;
    doblesAviso.hidden = !r.dobles;

    // Resaltar en el paño TODAS las casillas que ganan con esta tirada.
    const ganadoras = [zona.replace("dd-", "") + ":"];
    if (r.dobles) ganadoras.push("dobles:");
    if (suma !== 7) ganadoras.push(`suma:${suma}`);
    ganadoras.forEach((clave) =>
        pano.querySelector(`[data-clave="${clave}"]`)?.classList.add("dd-ganadora"));

    listaDetalle.innerHTML = "";
    r.apuestas.forEach((a) => {
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

    // Tiradas de la sesión (solo en memoria).
    tiradasSesion.unshift({ dado1: Number(r.dado1), dado2: Number(r.dado2), suma });
    tiradasSesion = tiradasSesion.slice(0, 10);
    pintarTiradas();
}

function pintarTiradas() {
    listaTiradas.innerHTML = "";
    tiradasVacio.hidden = tiradasSesion.length > 0;
    tiradasSesion.forEach((t) => {
        const li = document.createElement("li");
        if (t.dado1 === t.dado2) li.className = "dd-es-doble";
        li.title = `${t.dado1} y ${t.dado2}`;
        const caras = document.createElement("span");
        caras.className = "dd-caras";
        caras.textContent = CARAS_UNICODE[t.dado1 - 1] + CARAS_UNICODE[t.dado2 - 1];
        const suma = document.createElement("span");
        suma.textContent = `= ${t.suma}`;
        li.append(caras, suma);
        listaTiradas.appendChild(li);
    });
}

// ===== Historial (lectura directa: la política RLS solo deja ver lo propio) =====
let idJuego = null; // id de Dados en el catálogo, se busca por nombre

async function obtenerIdJuego() {
    if (idJuego !== null) return idJuego;

    // La política juego_leer_activos deja leer los juegos con estado = true.
    const { data, error } = await supabase
        .from("juego")
        .select("id_juego")
        .eq("nombre", NOMBRE_JUEGO)
        .eq("estado", true)
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
    const casilla = e.target.closest(".dd-casilla");
    if (casilla && !casilla.disabled) ponerFicha(casilla);
});
botonesFicha.forEach((b) => b.addEventListener("click", () => elegirFicha(b)));
btnDeshacer.addEventListener("click", deshacer);
btnLimpiar.addEventListener("click", limpiarApuestas);
btnRepetir.addEventListener("click", repetirAnterior);
btnTirar.addEventListener("click", tirar);

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

// Los dados empiezan mostrando 5 y 3, como la ilustración del index.
crearDado(0, 5);
crearDado(1, 3);
dibujarPano();
pintarApuestas();
pintarTiradas();
iniciar();
