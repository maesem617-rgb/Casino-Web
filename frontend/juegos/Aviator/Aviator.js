
/* ==========================================
   CASINOVIRTUAL - AVIATOR
   Conexión con Supabase
   Apuestas y premios con tokens virtuales
   Vuelo animado y explosión con partículas
   ========================================== */

import { supabase } from "../../js/supabase.js";

// ==========================================
// ELEMENTOS HTML
// ==========================================

const multiplicadorTexto =
    document.getElementById("multiplicador");

const avion = document.getElementById("avion");
const explosion = document.getElementById("explosion");
const rutaAvion = document.getElementById("rutaAvion");
const zonaVuelo = document.getElementById("zonaVuelo");
const mensaje = document.getElementById("mensaje");

const apuestaInput = document.getElementById("apuesta");
const btnApostar = document.getElementById("btnApostar");
const btnRetirar = document.getElementById("btnRetirar");

const saldoAviator =
    document.getElementById("saldoAviator");

// ==========================================
// VARIABLES
// ==========================================

let jugando = false;
let procesando = false;
let consultandoEstado = false;

let idRonda = null;
let numeroRonda = 0;

let multiplicador = 1;
let inicioVuelo = 0;

let animacion = null;
let intervaloEstado = null;

const VELOCIDAD_VUELO = 0.12;
const INTERVALO_CONSULTA = 200;

// El servidor genera accidentes entre
// aproximadamente 1.01x y 6.00x.
const MULTIPLICADOR_VISUAL_MAXIMO = 6;

// ==========================================
// UTILIDADES
// ==========================================

function mostrarSaldo(tokens) {
    if (!saldoAviator) return;

    const cantidad = Number(tokens);

    if (!Number.isFinite(cantidad)) return;

    saldoAviator.textContent =
        cantidad.toLocaleString("es-MX");
}

function mostrarError(error) {
    console.error("Error en Aviator:", error);

    mensaje.textContent =
        error?.message ||
        "Ocurrió un error inesperado.";
}

function actualizarBotones() {
    btnApostar.disabled = jugando || procesando;
    btnRetirar.disabled = !jugando || procesando;
    apuestaInput.disabled = jugando || procesando;
}

async function obtenerUsuario() {
    const { data, error } =
        await supabase.auth.getUser();

    if (error) throw error;

    return data.user;
}

// ==========================================
// CARGAR SALDO DESDE SUPABASE
// ==========================================

async function cargarSaldoAviator() {
    try {
        const usuario = await obtenerUsuario();

        if (!usuario) {
            if (saldoAviator) {
                saldoAviator.textContent = "—";
            }

            mensaje.textContent =
                "Inicia sesión para jugar Aviator.";

            return;
        }

        const { data: perfil, error } =
            await supabase
                .from("usuario")
                .select("tokens")
                .eq("id_usuario", usuario.id)
                .single();

        if (error) throw error;

        mostrarSaldo(perfil.tokens);

    } catch (error) {
        console.error(
            "Error al cargar saldo:",
            error
        );

        if (saldoAviator) {
            saldoAviator.textContent = "—";
        }
    }
}

// ==========================================
// MOVIMIENTO DEL AVIÓN
// ==========================================

function actualizarAvion() {
    const ancho = zonaVuelo.clientWidth;
    const alto = zonaVuelo.clientHeight;

    const anchoAvion = avion.offsetWidth;
    const altoAvion = avion.offsetHeight;

    const progreso = Math.min(
        Math.max((multiplicador - 1) / 3, 0),
        1
    );

    const inicioX = 15;
    const inicioY = alto - 15;

    const distanciaX = Math.max(
        0,
        ancho - anchoAvion - 35
    );

    const distanciaY = Math.max(
        0,
        alto - altoAvion - 25
    );

    // Movimiento curvo del avión.
    const x =
        inicioX + distanciaX * progreso;

    const altura =
        distanciaY *
        (1 - Math.pow(1 - progreso, 2));

    const y = inicioY - altura;

    avion.style.left = `${x}px`;

    avion.style.bottom =
        `${alto - y - 15}px`;

    const inclinacion =
        -10 - 18 * (1 - progreso);

    avion.style.transform =
        `rotate(${inclinacion}deg)`;

    // Estela morada.
    const controlX =
        inicioX + (x - inicioX) * 0.5;

    const controlY = inicioY;

    rutaAvion.setAttribute(
        "d",
        `M ${inicioX} ${inicioY}
         Q ${controlX} ${controlY}
           ${x} ${y}`
    );
}

// ==========================================
// REINICIAR AVIÓN
// ==========================================

function reiniciarAvion() {
    avion.classList.remove("explotando");

    avion.style.left = "15px";
    avion.style.bottom = "10px";

    avion.style.transform =
        "rotate(-15deg)";

    rutaAvion.setAttribute("d", "");

    if (explosion) {
        explosion.classList.remove("activa");
        explosion.innerHTML = "";
    }

    multiplicador = 1;

    multiplicadorTexto.style.color =
        "#ffc533";

    multiplicadorTexto.textContent =
        "1.00x";
}

// ==========================================
// EXPLOSIÓN CON PARTÍCULAS
// ==========================================

function crearExplosion() {
    if (!explosion) return;

    explosion.innerHTML = "";
    explosion.classList.add("activa");

    const rectZona =
        zonaVuelo.getBoundingClientRect();

    const rectAvion =
        avion.getBoundingClientRect();

    const centroX =
        rectAvion.left -
        rectZona.left +
        rectAvion.width / 2;

    const centroY =
        rectAvion.top -
        rectZona.top +
        rectAvion.height / 2;

    explosion.style.left =
        `${centroX}px`;

    explosion.style.top =
        `${centroY}px`;

    const cantidadParticulas = 24;

    for (let i = 0; i < cantidadParticulas; i++) {
        const particula =
            document.createElement("span");

        particula.classList.add(
            "particula"
        );

        const angulo =
            (Math.PI * 2 * i) /
            cantidadParticulas;

        const distancia =
            35 + Math.random() * 75;

        const dx =
            Math.cos(angulo) * distancia;

        const dy =
            Math.sin(angulo) * distancia;

        particula.style.setProperty(
            "--dx",
            `${dx}px`
        );

        particula.style.setProperty(
            "--dy",
            `${dy}px`
        );

        explosion.appendChild(particula);
    }
}

// ==========================================
// DETENER ANIMACIÓN
// ==========================================

function detenerAnimacion() {
    if (animacion !== null) {
        cancelAnimationFrame(animacion);
        animacion = null;
    }

    if (intervaloEstado !== null) {
        clearInterval(intervaloEstado);
        intervaloEstado = null;
    }
}

// ==========================================
// FINALIZAR RONDA
// ==========================================

function finalizarRonda() {
    jugando = false;
    procesando = false;

    idRonda = null;
    numeroRonda++;

    detenerAnimacion();
    actualizarBotones();
}

// ==========================================
// ACCIDENTE CONFIRMADO POR SUPABASE
// ==========================================

function estrellarAvion(datos) {
    const valor = Number(datos.multiplicador);

    if (
        Number.isFinite(valor) &&
        valor > 0
    ) {
        multiplicador = valor;
    }

    multiplicadorTexto.textContent =
        multiplicador.toFixed(2) + "x";

    actualizarAvion();

    multiplicadorTexto.style.color =
        "#ff5555";

    mensaje.textContent =
        `¡El avión se estrelló en ` +
        `${multiplicador.toFixed(2)}x! ` +
        `Perdiste tu apuesta.`;

    crearExplosion();

    avion.classList.add("explotando");

    if (datos.saldo_actual !== undefined) {
        mostrarSaldo(datos.saldo_actual);
    }

    finalizarRonda();
}

// ==========================================
// ANIMACIÓN DEL MULTIPLICADOR
// ==========================================

function animarVuelo(tiempoActual) {
    if (!jugando || procesando) return;

    // Utilizar el reloj monotónico del navegador.
    // Evita diferencias con el reloj de Supabase.
    const segundos = Math.max(
        0,
        (tiempoActual - inicioVuelo) / 1000
    );

    // Multiplicador visual.
    const multiplicadorVisual = Math.exp(
        Math.min(
            segundos * VELOCIDAD_VUELO,
            Math.log(MULTIPLICADOR_VISUAL_MAXIMO)
        )
    );

    // Nunca mostrar valores infinitos
    // ni cantidades gigantescas.
    multiplicador = Math.max(
        1,
        Math.min(
            multiplicadorVisual,
            MULTIPLICADOR_VISUAL_MAXIMO
        )
    );

    multiplicadorTexto.textContent =
        multiplicador.toFixed(2) + "x";

    actualizarAvion();

    animacion =
        requestAnimationFrame(animarVuelo);
}

// ==========================================
// CONSULTAR ESTADO EN SUPABASE
// ==========================================

async function consultarEstado() {
    if (
        !jugando ||
        procesando ||
        consultandoEstado ||
        idRonda === null
    ) {
        return;
    }

    const rondaConsultada = idRonda;
    const version = numeroRonda;

    consultandoEstado = true;

    try {
        const { data, error } =
            await supabase.rpc(
                "aviator_estado",
                {
                    p_id_ronda: rondaConsultada
                }
            );

        if (error) throw error;

        // Ignorar respuestas de rondas anteriores.
        if (
            version !== numeroRonda ||
            idRonda !== rondaConsultada
        ) {
            return;
        }

        if (!data) {
            throw new Error(
                "Supabase no devolvió el estado."
            );
        }

        // Avión estrellado.
        if (data.estado === "ESTRELLADA") {
            estrellarAvion(data);
            return;
        }

        // Ronda retirada.
        if (data.estado === "RETIRADA") {
            if (
                data.saldo_actual !== undefined
            ) {
                mostrarSaldo(data.saldo_actual);
            }

            mensaje.textContent =
                "Esta ronda ya fue retirada.";

            finalizarRonda();
            return;
        }

        if (data.estado !== "ACTIVA") {
            throw new Error(
                "Estado de ronda desconocido."
            );
        }

        // La ronda continúa activa.
        // No se genera ningún accidente local.

    } catch (error) {
        mostrarError(error);

        // Detener el juego hasta confirmar
        // qué ocurrió en Supabase.
        procesando = true;

        detenerAnimacion();
        actualizarBotones();

        mensaje.textContent =
            "No se pudo verificar la ronda. " +
            "Recarga la página antes de apostar.";

    } finally {
        consultandoEstado = false;
    }
}

// ==========================================
// BOTÓN APOSTAR
// ==========================================

btnApostar.addEventListener(
    "click",
    async () => {
        if (jugando || procesando) return;

        const cantidad =
            Number(apuestaInput.value);

        if (
            !Number.isSafeInteger(cantidad) ||
            cantidad <= 0 ||
            cantidad > 2147483647
        ) {
            mensaje.textContent =
                "Introduce una apuesta válida " +
                "en tokens enteros.";
            return;
        }

        procesando = true;
        actualizarBotones();

        mensaje.textContent =
            "Validando apuesta con Supabase...";

        try {
            const usuario =
                await obtenerUsuario();

            if (!usuario) {
                throw new Error(
                    "Debes iniciar sesión para apostar."
                );
            }

            // Registrar apuesta en Supabase.
            const { data, error } =
                await supabase.rpc(
                    "aviator_iniciar",
                    {
                        p_apuesta: cantidad
                    }
                );

            if (error) throw error;

            if (
                !data?.exito ||
                data.id_ronda == null
            ) {
                throw new Error(
                    data?.mensaje ||
                    "No se pudo iniciar el vuelo."
                );
            }

            idRonda = data.id_ronda;
            numeroRonda++;

            reiniciarAvion();

            if (
                data.saldo_actual !== undefined
            ) {
                mostrarSaldo(data.saldo_actual);
            }

            jugando = true;
            procesando = false;

            actualizarBotones();

            mensaje.textContent =
                "¡El avión está despegando!";

            // CORRECCIÓN PRINCIPAL:
            // No restar Date.now() con la fecha
            // del servidor para animar.
            inicioVuelo = performance.now();

            animacion =
                requestAnimationFrame(
                    animarVuelo
                );

            // Consultar estado real.
            consultarEstado();

            intervaloEstado =
                setInterval(
                    consultarEstado,
                    INTERVALO_CONSULTA
                );

        } catch (error) {
            mostrarError(error);

            procesando = false;
            jugando = false;

            detenerAnimacion();
            actualizarBotones();
        }
    }
);

// ==========================================
// BOTÓN RETIRAR
// ==========================================

btnRetirar.addEventListener(
    "click",
    async () => {
        if (
            !jugando ||
            procesando ||
            idRonda === null
        ) {
            return;
        }

        procesando = true;

        detenerAnimacion();
        actualizarBotones();

        mensaje.textContent =
            "Procesando retiro en Supabase...";

        try {
            const { data, error } =
                await supabase.rpc(
                    "aviator_retirar",
                    {
                        p_id_ronda: idRonda
                    }
                );

            if (error) throw error;

            if (!data) {
                throw new Error(
                    "Supabase no devolvió el retiro."
                );
            }

            // El avión se estrelló antes del retiro.
            if (data.estado === "ESTRELLADA") {
                const {
                    data: estado,
                    error: errorEstado
                } = await supabase.rpc(
                    "aviator_estado",
                    {
                        p_id_ronda: idRonda
                    }
                );

                if (errorEstado) {
                    throw errorEstado;
                }

                if (!estado) {
                    throw new Error(
                        "No se pudo consultar el accidente."
                    );
                }

                procesando = false;
                estrellarAvion(estado);
                return;
            }

            if (
                !data.exito ||
                data.estado !== "RETIRADA"
            ) {
                throw new Error(
                    data.mensaje ||
                    "No se pudo retirar la apuesta."
                );
            }

            multiplicador =
                Number(data.multiplicador);

            multiplicadorTexto.textContent =
                multiplicador.toFixed(2) + "x";

            multiplicadorTexto.style.color =
                "#ffc533";

            actualizarAvion();

            mostrarSaldo(data.saldo_actual);

            mensaje.textContent =
                `¡Retiraste a ` +
                `${multiplicador.toFixed(2)}x! ` +
                `Recibiste ` +
                `${Number(data.premio)
                    .toLocaleString("es-MX")} tokens.`;

            finalizarRonda();

        } catch (error) {
            mostrarError(error);

            // Evitar nuevas apuestas hasta
            // verificar el resultado real.
            procesando = true;

            actualizarBotones();

            mensaje.textContent =
                "No se pudo confirmar el retiro. " +
                "Recarga la página y verifica tu saldo.";
        }
    }
);

// ==========================================
// INICIAR JUEGO
// ==========================================

btnRetirar.disabled = true;

actualizarBotones();
cargarSaldoAviator();
