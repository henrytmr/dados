import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as CANNON from 'cannon-es';

/* ============================================================
   CONFIGURACIÓN
   ============================================================ */
const NUM_DADOS = 3;
const DADO_SIZE = 1;
const DADO_HALF = DADO_SIZE / 2;
const DADO_MASA = 2.5;
const GRAVEDAD = -32;
const FRICCION_MESA = 0.55;
const RESTITUCION_DADO = 0.35;
const LINEAR_DAMPING = 0.005;
const ANGULAR_DAMPING = 0.005;

const VASO_RADIO = 3.2;
const VASO_RADIO_INTERNO = VASO_RADIO - 0.18;
const VASO_ALTURA = 5.0;
const VASO_ALTURA_INTERNA = VASO_ALTURA - 0.2;

const VASO_Y_OCULTO = -8;
const VASO_Y_SOBRE_MESA = 3.0;
const VASO_Y_ELEVADO = 8.5;

const MESA_RADIO = 20;
const MESA_RADIO_SEGURO = 13;

const UMBRAL_AGITAR = 2.0;
const UMBRAL_MOVIMIENTO_MAX = 20;
const UMBRAL_ALERTA_SUELTA = UMBRAL_MOVIMIENTO_MAX * 0.92;

const TIEMPO_MIN_AGITACION = 900;

const API_BASE = '/api/v1';
const API_TIRADA = `${API_BASE}/tirada`;
const API_RESULTADO = `${API_BASE}/tirada/resultado`;
const TIEMPO_MAX_RED_MS = 800;
const TIEMPO_MAX_REPORTE_MS = 1500;

const MAX_INTENTOS_PRESIMULACION = 300;
const PASO_SIMULACION = 1 / 60;
const MAX_PASOS_POR_TIRADA = 480;
const PASOS_ANTES_DE_LIBERAR_PAREDES = 20;
const PASO_GRABACION = 2;

const TIEMPO_QUIETUD_MOVIL_MS = 700;
const TIEMPO_RESPALDO_AGITANDO_MS = 6000;
const TIEMPO_GUARDIAN_AGITANDO_MS = 8000;

const UMBRAL_AGITACION_MINIMA = 8;
const INTENTOS_MINIMOS_AGITACION = 15;

const FACTOR_INERCIA_VASO = 0.35;
const FACTOR_CENTRIFUGA = 0.6;

/* ⚡ Fluidez del replay */
const TIEMPO_BLEND_ENTRADA = 0.10;   // sale rápido de pose viva
const TIEMPO_BLEND_SALIDA = 0.15;    // aterriza suave en replay
const RAMP_DURACION = 0.30;          // ramp-up del replay
const RAMP_INICIAL = 1.8;            // 1.8x velocidad inicial

const VELOCIDAD_SUBIDA_VASO_SUELTA = 45;

/* ============================================================
   ESTADOS
   ============================================================ */
const ESTADOS = {
  ESPERANDO: 'esperando',
  VASO_APARECIENDO: 'vaso_apareciendo',
  AGITANDO: 'agitando',
  PRESIMULANDO: 'presimulando',
  DADOS_CAYENDO: 'dados_cayendo',
  DADOS_QUIETOS: 'dados_quietos'
};
let estadoActual = ESTADOS.ESPERANDO;
let tiempoEstado = 0;

/* ============================================================
   GLOBALES
   ============================================================ */
let scene, camera, renderer, controls;
let world, mesaBody, sueloRespaldo;
let mesaMesh;
let bordeRebote;
let paredesMesa = [];
let dados = [];
let vasoGroup;
let vasoParedes = [];

let vasoYActual = VASO_Y_OCULTO;
let vasoYObjetivo = VASO_Y_OCULTO;
let velocidadVaso = 10;

let ultimoAcc = { x: 0, y: 0, z: 0 };
let magnitudSuavizada = 0;
let magnitudMaximaReciente = 0;
let acelerometroActivo = false;
let tiempoInicioAgitacion = 0;
let ultimaQuietud = 0;
let alertaMostrada = false;
let yaSeSolto = false;

let agitacionSuficienteAlcanzada = false;
let contadorAgitacionesFuertes = 0;

let tiltX = 0;
let tiltSuavX = 0;

let agitacionFase = 0;
let agitacionAmplitud = 0;
let agitacionDireccionX = 0;
let agitacionDireccionZ = 0;

let ultimaPosVasoX = 0;
let ultimaPosVasoZ = 0;
let velocidadVasoX = 0;
let velocidadVasoZ = 0;

let camTargetObjetivo = new THREE.Vector3(0, 0, 0);
let camOffsetActual = new THREE.Vector3(0, 10, 14);
let camOffsetObjetivo = new THREE.Vector3(0, 10, 14);
const boundingBox3D = new THREE.Box3();

let valoresObjetivo = [null, null, null];
let modoObjetivo = 'random';
let tiradaEnCurso = null;

let trayectoriaObjetivo = null;
let tiempoInicioReplay = 0;
let replayTerminado = false;

let poseViva = null;
let duracionFrameReplay = 0;

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qOff = new THREE.Quaternion();
const _qW = new THREE.Quaternion();

let ultimaPosicionDados = [];
let tiempoSinMoverse = [];

/* ============================================================
   SESIÓN
   ============================================================ */
function uuidv4() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
const SESION_ID = (() => {
  let s = sessionStorage.getItem('silo_sesion_id');
  if (!s) { s = uuidv4(); sessionStorage.setItem('silo_sesion_id', s); }
  return s;
})();

/* ============================================================
   UI
   ============================================================ */
const barraRevolucion = document.getElementById('barra-revolucion');
const barraTrack = document.getElementById('barra-track');
const barraFill = document.getElementById('barra-fill');
const barraPorcentaje = document.getElementById('barra-porcentaje');
const alertaSoltar = document.getElementById('alerta-soltar');
const btnAccion = document.getElementById('btn-accion');
const btnAccionTexto = document.getElementById('btn-accion-texto');
const hintInicial = document.getElementById('hint-inicial');

/* ============================================================
   CARAS
   ============================================================ */
const FACES_LOCALES = [
  new THREE.Vector3( 1, 0, 0),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3( 0, 1, 0),
  new THREE.Vector3( 0,-1, 0),
  new THREE.Vector3( 0, 0, 1),
  new THREE.Vector3( 0, 0,-1),
];

const _qTmp = new THREE.Quaternion();
const _nTmp = new THREE.Vector3();

function caraSuperior(body) {
  _qTmp.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
  let mejorIdx = 0, mejorCos = -2;
  for (let i = 0; i < 6; i++) {
    _nTmp.copy(FACES_LOCALES[i]).applyQuaternion(_qTmp);
    if (_nTmp.y > mejorCos) {
      mejorCos = _nTmp.y;
      mejorIdx = i;
    }
  }
  return mejorIdx;
}

/* ============================================================
   TEXTURAS
   ============================================================ */
function crearTexturaCara(numero) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 256;
  const ctx = canvas.getContext('2d');

  const grad = ctx.createRadialGradient(110, 95, 20, 128, 128, 190);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.35, '#fdfaf2');
  grad.addColorStop(0.75, '#f3ecdb');
  grad.addColorStop(1, '#e0d3b8');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);

  ctx.strokeStyle = 'rgba(160, 135, 90, 0.35)';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, 250, 250);

  const posiciones = {
    1: [[128, 128]],
    2: [[82, 82], [174, 174]],
    3: [[82, 82], [128, 128], [174, 174]],
    4: [[82, 82], [82, 174], [174, 82], [174, 174]],
    5: [[82, 82], [82, 174], [128, 128], [174, 82], [174, 174]],
    6: [[82, 68], [82, 128], [82, 188], [174, 68], [174, 128], [174, 188]]
  };

  (posiciones[numero] || []).forEach(([x, y]) => {
    ctx.beginPath();
    ctx.arc(x + 3, y + 3, 24, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.fill();

    const pipGrad = ctx.createRadialGradient(x - 8, y - 8, 2, x, y, 24);
    pipGrad.addColorStop(0, '#7a1a1a');
    pipGrad.addColorStop(0.5, '#3a0808');
    pipGrad.addColorStop(1, '#0a0202');
    ctx.beginPath();
    ctx.arc(x, y, 22, 0, Math.PI * 2);
    ctx.fillStyle = pipGrad;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x - 8, y - 8, 7, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 200, 200, 0.35)';
    ctx.fill();
  });

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 8;
  return tex;
}

/* ============================================================
   GEOMETRÍA / MATERIALES
   ============================================================ */
function crearGeometriaDado() {
  const geo = new THREE.BoxGeometry(DADO_SIZE, DADO_SIZE, DADO_SIZE);
  const pos = geo.attributes.position;
  const temp = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    temp.fromBufferAttribute(pos, i);
    const dist = temp.length();
    const factor = 1 - Math.pow(dist / (DADO_HALF * 1.75), 4) * 0.035;
    temp.multiplyScalar(factor);
    pos.setXYZ(i, temp.x, temp.y, temp.z);
  }
  geo.computeVertexNormals();
  return geo;
}

function crearMaterialDado() {
  return new THREE.MeshPhysicalMaterial({
    color: 0xfffcf5,
    roughness: 0.22,
    metalness: 0.02,
    clearcoat: 0.85,
    clearcoatRoughness: 0.12,
    reflectivity: 0.35,
    sheen: 0.25,
    sheenColor: new THREE.Color(0xfff0d8),
    envMapIntensity: 1.0
  });
}

/* ============================================================
   ESCENA
   ============================================================ */
function initThree() {
  const container = document.getElementById('canvas-container');
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xd9cfc0);
  scene.fog = new THREE.Fog(0xd9cfc0, 45, 95);

  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(0, 12, 16);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enableRotate = true;
  controls.enableZoom = true;
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.minPolarAngle = 0;
  controls.maxPolarAngle = Math.PI;
  controls.minDistance = 1;
  controls.maxDistance = 100;
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  controls.target.set(0, 0, 0);
  controls.update();
}

function initLuces() {
  scene.add(new THREE.HemisphereLight(0xffffff, 0xc9b998, 1.15));
  scene.add(new THREE.AmbientLight(0xfff5e6, 0.65));

  const spot = new THREE.SpotLight(0xfff6e0, 2.3, 55, Math.PI / 4, 0.5, 1.0);
  spot.position.set(0, 24, 4);
  spot.target.position.set(0, 0, 0);
  spot.castShadow = true;
  spot.shadow.mapSize.width = 2048;
  spot.shadow.mapSize.height = 2048;
  spot.shadow.bias = -0.0005;
  spot.shadow.radius = 5;
  scene.add(spot, spot.target);

  const fill = new THREE.DirectionalLight(0xfff0d8, 0.9);
  fill.position.set(-6, 10, 10);
  fill.castShadow = true;
  fill.shadow.mapSize.width = 1024;
  fill.shadow.mapSize.height = 1024;
  fill.shadow.camera.left = -22;
  fill.shadow.camera.right = 22;
  fill.shadow.camera.top = 22;
  fill.shadow.camera.bottom = -22;
  scene.add(fill);

  const rim = new THREE.PointLight(0xffd9a0, 0.8, 30);
  rim.position.set(10, 6, -8);
  scene.add(rim);
}

/* ============================================================
   MESA
   ============================================================ */
function crearMesa() {
  const mesaGeo = new THREE.CircleGeometry(MESA_RADIO, 96);
  const mesaMat = new THREE.MeshPhysicalMaterial({
    color: 0x2a8a52,
    roughness: 0.75,
    metalness: 0.0,
    clearcoat: 0.15,
    clearcoatRoughness: 0.6,
    sheen: 0.35,
    sheenColor: new THREE.Color(0x4ab070)
  });
  mesaMesh = new THREE.Mesh(mesaGeo, mesaMat);
  mesaMesh.rotation.x = -Math.PI / 2;
  mesaMesh.receiveShadow = true;
  scene.add(mesaMesh);

  const bordeGeo = new THREE.TorusGeometry(MESA_RADIO, 0.25, 20, 120);
  const bordeMat = new THREE.MeshPhysicalMaterial({
    color: 0xe0c072, roughness: 0.22, metalness: 0.95,
    clearcoat: 1.0, clearcoatRoughness: 0.08
  });
  bordeRebote = new THREE.Mesh(bordeGeo, bordeMat);
  bordeRebote.rotation.x = -Math.PI / 2;
  bordeRebote.position.y = 0.15;
  bordeRebote.receiveShadow = true;
  scene.add(bordeRebote);

  const muroGeo = new THREE.TorusGeometry(MESA_RADIO - 0.5, 0.5, 20, 120);
  const muroMat = new THREE.MeshPhysicalMaterial({
    color: 0x1a5a30, roughness: 0.7, metalness: 0.1,
    clearcoat: 0.2, clearcoatRoughness: 0.5
  });
  const muro = new THREE.Mesh(muroGeo, muroMat);
  muro.rotation.x = -Math.PI / 2;
  muro.position.y = 0.45;
  muro.receiveShadow = true;
  scene.add(muro);
}

/* ============================================================
   VASO
   ============================================================ */
function crearVaso() {
  vasoGroup = new THREE.Group();
  vasoGroup.position.set(0, VASO_Y_OCULTO, 0);

  const vidrioMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0.0,
    roughness: 0.04,
    transmission: 0.98,
    thickness: 0.6,
    ior: 1.5,
    clearcoat: 1.0,
    clearcoatRoughness: 0.03,
    reflectivity: 0.4,
    transparent: true,
    opacity: 0.30,
    side: THREE.DoubleSide,
    envMapIntensity: 1.5,
    depthWrite: false
  });

  const cuerpoGeo = new THREE.CylinderGeometry(
    VASO_RADIO, VASO_RADIO * 0.92, VASO_ALTURA, 48, 1, true
  );
  vasoGroup.add(new THREE.Mesh(cuerpoGeo, vidrioMat));

  const fondoGeo = new THREE.CircleGeometry(VASO_RADIO * 0.92, 48);
  const fondoMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0.0, roughness: 0.1,
    transmission: 0.9, thickness: 0.3,
    transparent: true, opacity: 0.22, side: THREE.DoubleSide
  });
  const fondo = new THREE.Mesh(fondoGeo, fondoMat);
  fondo.rotation.x = -Math.PI / 2;
  fondo.position.y = -VASO_ALTURA / 2;
  vasoGroup.add(fondo);

  const aroMat = new THREE.MeshPhysicalMaterial({
    color: 0xe0c072, roughness: 0.2, metalness: 0.95,
    clearcoat: 1.0, clearcoatRoughness: 0.05
  });

  const aroSup = new THREE.Mesh(
    new THREE.TorusGeometry(VASO_RADIO, 0.06, 12, 60), aroMat
  );
  aroSup.rotation.x = Math.PI / 2;
  aroSup.position.y = VASO_ALTURA / 2;
  vasoGroup.add(aroSup);

  const aroInf = new THREE.Mesh(
    new THREE.TorusGeometry(VASO_RADIO * 0.92, 0.05, 12, 60), aroMat
  );
  aroInf.rotation.x = Math.PI / 2;
  aroInf.position.y = -VASO_ALTURA / 2;
  vasoGroup.add(aroInf);

  vasoGroup.visible = false;
  scene.add(vasoGroup);
}

/* ============================================================
   FÍSICA
   ============================================================ */
function initPhysics() {
  world = new CANNON.World({
    gravity: new CANNON.Vec3(0, GRAVEDAD, 0),
    allowSleep: true
  });
  world.defaultContactMaterial.friction = FRICCION_MESA;
  world.defaultContactMaterial.restitution = RESTITUCION_DADO;
  world.solver.iterations = 20;

  const matDado = new CANNON.Material('dado');
  const matVaso = new CANNON.Material('vaso');
  const matMesa = new CANNON.Material('mesa');
  const matBorde = new CANNON.Material('borde');

  world.addContactMaterial(new CANNON.ContactMaterial(matDado, matVaso, {
    friction: 0.01, restitution: 0.92,
  }));
  world.addContactMaterial(new CANNON.ContactMaterial(matDado, matMesa, {
    friction: 0.4, restitution: 0.35,
  }));
  world.addContactMaterial(new CANNON.ContactMaterial(matDado, matBorde, {
    friction: 0.2, restitution: 0.85,
  }));
  world.addContactMaterial(new CANNON.ContactMaterial(matDado, matDado, {
    friction: 0.05, restitution: 0.95,
  }));

  mesaBody = new CANNON.Body({
    type: CANNON.Body.STATIC,
    shape: new CANNON.Plane()
  });
  mesaBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  mesaBody.material = matMesa;
  world.addBody(mesaBody);

  sueloRespaldo = new CANNON.Body({
    type: CANNON.Body.STATIC,
    shape: new CANNON.Box(new CANNON.Vec3(MESA_RADIO, 2, MESA_RADIO))
  });
  sueloRespaldo.position.set(0, -2, 0);
  world.addBody(sueloRespaldo);

  const N = 96;
  for (let i = 0; i < N; i++) {
    const angulo = (i / N) * Math.PI * 2;
    const nextAngulo = ((i + 1) / N) * Math.PI * 2;
    const midAngulo = (angulo + nextAngulo) / 2;
    const midX = Math.cos(midAngulo) * (MESA_RADIO - 0.5);
    const midZ = Math.sin(midAngulo) * (MESA_RADIO - 0.5);

    const body = new CANNON.Body({ type: CANNON.Body.STATIC });
    body.addShape(new CANNON.Plane());
    body.position.set(midX, 0.75, midZ);
    const normal = new CANNON.Vec3(-midX, 0, -midZ);
    normal.normalize();
    const quat = new CANNON.Quaternion();
    quat.setFromVectors(new CANNON.Vec3(0, 0, 1), normal);
    body.quaternion.copy(quat);
    body.material = matBorde;
    paredesMesa.push(body);
    world.addBody(body);
  }
}

/* ============================================================
   PAREDES FÍSICAS DEL VASO
   ============================================================ */
function crearParedesFisicasVaso() {
  quitarParedesFisicasVaso();

  const matVaso = new CANNON.Material('vaso');
  const N = 32;
  for (let i = 0; i < N; i++) {
    const angulo = (i / N) * Math.PI * 2;
    const nextAngulo = ((i + 1) / N) * Math.PI * 2;
    const midX = Math.cos((angulo + nextAngulo) / 2) * VASO_RADIO_INTERNO;
    const midZ = Math.sin((angulo + nextAngulo) / 2) * VASO_RADIO_INTERNO;

    const body = new CANNON.Body({ type: CANNON.Body.STATIC });
    body.addShape(new CANNON.Plane());
    body.position.set(midX, 0, midZ);
    const normal = new CANNON.Vec3(-midX, 0, -midZ);
    normal.normalize();
    const quat = new CANNON.Quaternion();
    quat.setFromVectors(new CANNON.Vec3(0, 0, 1), normal);
    body.quaternion.copy(quat);
    body.material = matVaso;
    body.userData = { offsetY: 0 };
    vasoParedes.push(body);
    world.addBody(body);
  }

  const techo = new CANNON.Body({ type: CANNON.Body.STATIC });
  techo.addShape(new CANNON.Plane());
  techo.position.set(0, VASO_ALTURA_INTERNA / 2, 0);
  techo.quaternion.setFromEuler(Math.PI / 2, 0, 0);
  techo.material = matVaso;
  techo.userData = { offsetY: VASO_ALTURA_INTERNA / 2 };
  vasoParedes.push(techo);
  world.addBody(techo);

  const fondo = new CANNON.Body({ type: CANNON.Body.STATIC });
  fondo.addShape(new CANNON.Plane());
  fondo.position.set(0, -VASO_ALTURA_INTERNA / 2, 0);
  fondo.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  fondo.material = matVaso;
  fondo.userData = { offsetY: -VASO_ALTURA_INTERNA / 2 };
  vasoParedes.push(fondo);
  world.addBody(fondo);
}

function quitarParedesFisicasVaso() {
  vasoParedes.forEach(p => world.removeBody(p));
  vasoParedes = [];
}

function moverParedesVasoConShake(x, z) {
  vasoParedes.forEach(p => {
    p.position.y = vasoYActual + p.userData.offsetY;
    p.position.x = x;
    p.position.z = z;
  });
}

/* ============================================================
   DADOS
   ============================================================ */
function crearDado(index) {
  const geo = crearGeometriaDado();
  const materiales = [];
  for (let i = 1; i <= 6; i++) {
    const m = crearMaterialDado();
    m.map = crearTexturaCara(i);
    materiales.push(m);
  }

  const mesh = new THREE.Mesh(geo, materiales);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);

  const shape = new CANNON.Box(new CANNON.Vec3(DADO_HALF, DADO_HALF, DADO_HALF));
  const body = new CANNON.Body({
    mass: DADO_MASA,
    shape,
    linearDamping: LINEAR_DAMPING,
    angularDamping: ANGULAR_DAMPING,
    allowSleep: false,
    sleepSpeedLimit: 0.03,
    sleepTimeLimit: 1.0
  });

  body.material = new CANNON.Material('dado');
  body.ccdSpeedThreshold = 5;
  body.ccdIterations = 15;

  const ang = (index / NUM_DADOS) * Math.PI * 2;
  body.position.set(Math.cos(ang) * 0.7, DADO_HALF + 0.1, Math.sin(ang) * 0.7);
  body.quaternion.setFromEuler(0, 0, 0);
  world.addBody(body);

  dados.push({ mesh, body, index });

  ultimaPosicionDados[index] = new THREE.Vector3(body.position.x, body.position.y, body.position.z);
  tiempoSinMoverse[index] = 0;
}

function crearTodosLosDados() {
  for (let i = 0; i < NUM_DADOS; i++) crearDado(i);
}

function sincronizar() {
  dados.forEach(d => {
    d.mesh.position.copy(d.body.position);
    d.mesh.quaternion.copy(d.body.quaternion);
  });
}

function corregirDadosCaidos() {
  dados.forEach(d => {
    if (d.body.position.y < -1.5) {
      d.body.position.set(
        (Math.random() - 0.5) * 4,
        DADO_HALF + 0.1,
        (Math.random() - 0.5) * 4
      );
      d.body.velocity.set(0, 0, 0);
      d.body.angularVelocity.set(0, 0, 0);
    }
  });
}

/* ============================================================
   ESTADO
   ============================================================ */
function cambiarEstado(nuevo) {
  estadoActual = nuevo;
  tiempoEstado = performance.now();
  console.log('→ Estado:', nuevo);
}

/* ============================================================
   VALIDACIÓN DE REGLAS
   ============================================================ */
function cumpleReglaLocal(modo, valores) {
  if (!Array.isArray(valores) || valores.length !== 3) return false;
  if (valores.some(v => !Number.isInteger(v) || v < 1 || v > 6)) return false;
  if (modo === 'random') return true;

  const ordenados = [...valores].sort((a, b) => a - b);

  if (modo === 'ganar') {
    if (valores[0] === 1 && valores[1] === 1 && valores[2] === 1) return true;
    if (ordenados[0] === 4 && ordenados[1] === 5 && ordenados[2] === 6) return true;
    const conteo = {};
    valores.forEach(v => conteo[v] = (conteo[v] || 0) + 1);
    for (const [v, n] of Object.entries(conteo)) {
      const vi = Number(v);
      if (n >= 2 && [1, 2, 3].includes(vi)) {
        const resto = [...valores];
        resto.splice(resto.indexOf(vi), 1);
        resto.splice(resto.indexOf(vi), 1);
        if (resto.length === 1 && [4, 5, 6].includes(resto[0])) return true;
      }
    }
    return false;
  }

  if (modo === 'perder') {
    const cuentaUnos = valores.filter(v => v === 1).length;
    if (cuentaUnos !== 1) return false;
    const resto = valores.filter(v => v !== 1);
    return resto.length === 2 && resto[0] === resto[1] && resto[0] !== 1;
  }
  return false;
}

/* ============================================================
   PRE-SIMULACIÓN OCULTA
   ============================================================ */
function simularTiradaOculta(impulsos) {
  const w = new CANNON.World({ gravity: new CANNON.Vec3(0, GRAVEDAD, 0) });
  w.defaultContactMaterial.friction = FRICCION_MESA;
  w.defaultContactMaterial.restitution = RESTITUCION_DADO;
  w.solver.iterations = 20;

  const matDado = new CANNON.Material('dado');
  const matVaso = new CANNON.Material('vaso');
  const matMesa = new CANNON.Material('mesa');
  const matBorde = new CANNON.Material('borde');

  w.addContactMaterial(new CANNON.ContactMaterial(matDado, matVaso, {
    friction: 0.01, restitution: 0.92,
  }));
  w.addContactMaterial(new CANNON.ContactMaterial(matDado, matMesa, {
    friction: 0.4, restitution: 0.35,
  }));
  w.addContactMaterial(new CANNON.ContactMaterial(matDado, matBorde, {
    friction: 0.2, restitution: 0.85,
  }));
  w.addContactMaterial(new CANNON.ContactMaterial(matDado, matDado, {
    friction: 0.05, restitution: 0.95,
  }));

  const mesa = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Plane() });
  mesa.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  mesa.material = matMesa;
  w.addBody(mesa);

  const N_BORDE = 96;
  for (let i = 0; i < N_BORDE; i++) {
    const midAngulo = ((i + 0.5) / N_BORDE) * Math.PI * 2;
    const midX = Math.cos(midAngulo) * (MESA_RADIO - 0.5);
    const midZ = Math.sin(midAngulo) * (MESA_RADIO - 0.5);
    const body = new CANNON.Body({ type: CANNON.Body.STATIC });
    body.addShape(new CANNON.Plane());
    body.position.set(midX, 0.75, midZ);
    const normal = new CANNON.Vec3(-midX, 0, -midZ);
    normal.normalize();
    body.quaternion.setFromVectors(new CANNON.Vec3(0, 0, 1), normal);
    body.material = matBorde;
    w.addBody(body);
  }

  const paredes = [];
  const N_VASO = 32;
  for (let i = 0; i < N_VASO; i++) {
    const a = (i / N_VASO) * Math.PI * 2;
    const b = ((i + 1) / N_VASO) * Math.PI * 2;
    const mx = Math.cos((a + b) / 2) * VASO_RADIO_INTERNO;
    const mz = Math.sin((a + b) / 2) * VASO_RADIO_INTERNO;
    const body = new CANNON.Body({ type: CANNON.Body.STATIC });
    body.addShape(new CANNON.Plane());
    body.position.set(mx, VASO_Y_ELEVADO, mz);
    const n = new CANNON.Vec3(-mx, 0, -mz);
    n.normalize();
    const q = new CANNON.Quaternion();
    q.setFromVectors(new CANNON.Vec3(0, 0, 1), n);
    body.quaternion.copy(q);
    body.material = matVaso;
    w.addBody(body);
    paredes.push(body);
  }

  const fondo = new CANNON.Body({ type: CANNON.Body.STATIC });
  fondo.addShape(new CANNON.Plane());
  fondo.position.set(0, VASO_Y_ELEVADO - VASO_ALTURA_INTERNA / 2, 0);
  fondo.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  fondo.material = matVaso;
  w.addBody(fondo);
  paredes.push(fondo);

  const cuerpos = [];
  for (let i = 0; i < NUM_DADOS; i++) {
    const shape = new CANNON.Box(new CANNON.Vec3(DADO_HALF, DADO_HALF, DADO_HALF));
    const b = new CANNON.Body({
      mass: DADO_MASA, shape,
      linearDamping: 0.02,
      angularDamping: 0.05,
      allowSleep: false
    });
    b.material = matDado;
    const ang = (i / NUM_DADOS) * Math.PI * 2;
    b.position.set(
      Math.cos(ang) * 0.7,
      VASO_Y_ELEVADO + (i - 1) * 0.5,
      Math.sin(ang) * 0.7
    );
    b.quaternion.setFromEuler(
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2
    );
    b.velocity.set(impulsos[i].vx, impulsos[i].vy, impulsos[i].vz);
    b.angularVelocity.set(impulsos[i].ax, impulsos[i].ay, impulsos[i].az);
    w.addBody(b);
    cuerpos.push(b);
  }

  const trayectoria = [];
  let pasoFinal = 0;

  for (let paso = 0; paso < MAX_PASOS_POR_TIRADA; paso++) {
    if (paso === PASOS_ANTES_DE_LIBERAR_PAREDES) {
      paredes.forEach(p => w.removeBody(p));
    }

    w.step(PASO_SIMULACION);
    pasoFinal = paso;

    if (paso % PASO_GRABACION === 0) {
      trayectoria.push({
        dados: cuerpos.map(c => ({
          x: c.position.x, y: c.position.y, z: c.position.z,
          qx: c.quaternion.x, qy: c.quaternion.y, qz: c.quaternion.z, qw: c.quaternion.w,
        })),
      });
    }

    if (paso > 100) {
      const quietos = cuerpos.every(c =>
        c.velocity.length() < 0.15 && c.angularVelocity.length() < 0.25
      );
      if (quietos) {
        trayectoria.push({
          dados: cuerpos.map(c => ({
            x: c.position.x, y: c.position.y, z: c.position.z,
            qx: c.quaternion.x, qy: c.quaternion.y, qz: c.quaternion.z, qw: c.quaternion.w,
          })),
        });
        break;
      }
    }
  }

  const valores = cuerpos.map(c => caraSuperior(c) + 1);
  return { valores, trayectoria, pasosTotales: pasoFinal };
}

/* ⚡ Impulsos alineados con la agitación real del usuario */
function generarImpulsosAleatorios() {
  const impulsos = [];
  const factor = Math.min(magnitudSuavizada / UMBRAL_MOVIMIENTO_MAX, 1);
  const intensidad = 20 + factor * 40;

  for (let i = 0; i < NUM_DADOS; i++) {
    impulsos.push({
      vx: (Math.random() - 0.5) * intensidad,
      vy: (Math.random() - 0.5) * intensidad + 22,
      vz: (Math.random() - 0.5) * intensidad,
      ax: (Math.random() - 0.5) * 100,
      ay: (Math.random() - 0.5) * 100,
      az: (Math.random() - 0.5) * 100,
    });
  }
  return impulsos;
}

function encontrarTrayectoriaQueCumple() {
  const t0 = performance.now();
  for (let intento = 0; intento < MAX_INTENTOS_PRESIMULACION; intento++) {
    const impulsos = generarImpulsosAleatorios();
    const { valores, trayectoria } = simularTiradaOculta(impulsos);

    if (cumpleReglaLocal(modoObjetivo, valores)) {
      const ms = performance.now() - t0;
      console.log(`✅ Pre-simulación OK en intento ${intento + 1} (${ms.toFixed(1)}ms). Valores:`, valores);
      return trayectoria;
    }
  }
  console.warn('⚠️ Pre-simulación agotada sin cumplir la regla');
  return null;
}

/* ============================================================
   REPLAY CON RAMP-UP Y BLEND ASIMÉTRICO
   ============================================================ */
function avanzarReplay() {
  if (!trayectoriaObjetivo || trayectoriaObjetivo.length === 0) return true;

  const tiempoTranscurrido = (performance.now() - tiempoInicioReplay) / 1000;

  /* ⚡ RAMP-UP: los primeros 0.30s corren más rápido para empalmar con la inercia del vaso */
  let factorVelocidad = 1.0;
  if (tiempoTranscurrido < RAMP_DURACION) {
    const tRamp = tiempoTranscurrido / RAMP_DURACION;
    factorVelocidad = RAMP_INICIAL - (RAMP_INICIAL - 1.0) * tRamp;
  }

  const tiempoReplayEfectivo = tiempoTranscurrido * factorVelocidad;
  const idx = Math.floor(tiempoReplayEfectivo / duracionFrameReplay);

  if (idx >= trayectoriaObjetivo.length - 1) {
    aplicarFrameFinal(trayectoriaObjetivo.length - 1);
    return true;
  }

  const i = Math.max(0, Math.min(idx, trayectoriaObjetivo.length - 2));
  const t = Math.max(0, Math.min(1, (tiempoReplayEfectivo / duracionFrameReplay) - i));

  const A = trayectoriaObjetivo[i];
  const B = trayectoriaObjetivo[i + 1];
  const T0 = trayectoriaObjetivo[0];

  /* ⚡ BLEND ASIMÉTRICO: entrada rápida (0.10s) y salida suave (0.15s) */
  let w = 0;
  if (poseViva) {
    if (tiempoTranscurrido < TIEMPO_BLEND_ENTRADA) {
      // Fase de entrada: 1 → 0 rápidamente
      const tb = tiempoTranscurrido / TIEMPO_BLEND_ENTRADA;
      w = 1 - tb * tb;
    } else if (tiempoTranscurrido < TIEMPO_BLEND_ENTRADA + TIEMPO_BLEND_SALIDA) {
      // Fase de salida: 0.15s de transición suave
      const tb = (tiempoTranscurrido - TIEMPO_BLEND_ENTRADA) / TIEMPO_BLEND_SALIDA;
      w = (1 - tb) * 0.1;
    }
    // Después de eso, w = 0 (replay puro)
  }

  dados.forEach((d, k) => {
    const pa = A.dados[k];
    const pb = B.dados[k];

    let x = pa.x + (pb.x - pa.x) * t;
    let y = pa.y + (pb.y - pa.y) * t;
    let z = pa.z + (pb.z - pa.z) * t;

    _qa.set(pa.qx, pa.qy, pa.qz, pa.qw);
    _qb.set(pb.qx, pb.qy, pb.qz, pb.qw);
    _qa.slerp(_qb, t);

    if (w > 0 && poseViva[k]) {
      const v = poseViva[k];
      const p0 = T0.dados[k];
      x += (v.x - p0.x) * w;
      y += (v.y - p0.y) * w;
      z += (v.z - p0.z) * w;
      y = Math.max(y, DADO_HALF);

      _qb.set(p0.qx, p0.qy, p0.qz, p0.qw).invert();
      _qOff.copy(v.q).multiply(_qb);
      _qW.set(0, 0, 0, 1).slerp(_qOff, w);
      _qa.premultiply(_qW);
    }

    d.body.position.set(x, y, z);
    d.body.previousPosition.set(x, y, z);
    d.body.interpolatedPosition.set(x, y, z);
    d.body.quaternion.set(_qa.x, _qa.y, _qa.z, _qa.w);
    d.body.previousQuaternion.set(_qa.x, _qa.y, _qa.z, _qa.w);
    d.body.interpolatedQuaternion.set(_qa.x, _qa.y, _qa.z, _qa.w);
    d.body.velocity.set(0, 0, 0);
    d.body.angularVelocity.set(0, 0, 0);

    d.mesh.position.set(x, y, z);
    d.mesh.quaternion.copy(_qa);
  });

  return false;
}

function aplicarFrameFinal(indice) {
  if (!trayectoriaObjetivo || indice < 0 || indice >= trayectoriaObjetivo.length) return;
  const frame = trayectoriaObjetivo[indice];
  dados.forEach((d, k) => {
    const p = frame.dados[k];
    d.body.position.set(p.x, p.y, p.z);
    d.body.previousPosition.set(p.x, p.y, p.z);
    d.body.interpolatedPosition.set(p.x, p.y, p.z);
    d.body.quaternion.set(p.qx, p.qy, p.qz, p.qw);
    d.body.previousQuaternion.set(p.qx, p.qy, p.qz, p.qw);
    d.body.interpolatedQuaternion.set(p.qx, p.qy, p.qz, p.qw);
    d.body.velocity.set(0, 0, 0);
    d.body.angularVelocity.set(0, 0, 0);
    d.mesh.position.set(p.x, p.y, p.z);
    d.mesh.quaternion.set(p.qx, p.qy, p.qz, p.qw);
  });
}

/* ============================================================
   RED
   ============================================================ */
async function pedirTirada() {
  const solicitud_id = uuidv4();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIEMPO_MAX_RED_MS);
  try {
    const r = await fetch(API_TIRADA, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sesion_id: SESION_ID, solicitud_id }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await r.json().catch(() => null);
    if (!data || data.ok !== true) {
      return { ok: false, error: data?.error || 'respuesta_invalida' };
    }
    if (!Array.isArray(data.valores) || data.valores.length !== 3 ||
        typeof data.id_tirada !== 'string' || typeof data.modo !== 'string') {
      return { ok: false, error: 'esquema_invalido' };
    }
    return { ok: true, id_tirada: data.id_tirada, valores: data.valores.slice(), modo: data.modo, solicitud_id };
  } catch (e) {
    clearTimeout(timeoutId);
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : 'red' };
  }
}

async function reportarResultado(id_tirada, valores_mostrados) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIEMPO_MAX_REPORTE_MS);
  try {
    const r = await fetch(API_RESULTADO, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_tirada, valores_mostrados }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await r.json().catch(() => null);
    return data && data.ok === true ? { ok: true } : { ok: false, error: data?.error || 'reporte_fallido' };
  } catch (e) {
    clearTimeout(timeoutId);
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : 'red' };
  }
}

/* ============================================================
   INERCIA Y CENTRÍFUGA
   ============================================================ */
function aplicarInerciaDelVaso() {
  if (estadoActual !== ESTADOS.AGITANDO) return;
  const velVasoX = velocidadVasoX;
  const velVasoZ = velocidadVasoZ;
  if (Math.abs(velVasoX) < 0.1 && Math.abs(velVasoZ) < 0.1) return;

  dados.forEach(d => {
    const dentroVaso = d.body.position.y > vasoYActual - VASO_ALTURA / 2 &&
                       d.body.position.y < vasoYActual + VASO_ALTURA / 2;
    if (!dentroVaso) return;

    const fuerzaX = -velVasoX * DADO_MASA * FACTOR_INERCIA_VASO;
    const fuerzaZ = -velVasoZ * DADO_MASA * FACTOR_INERCIA_VASO;

    d.body.applyForce(
      new CANNON.Vec3(fuerzaX, 0, fuerzaZ),
      new CANNON.Vec3(0, 0, 0)
    );

    d.body.angularVelocity.x += -velVasoZ * 0.3;
    d.body.angularVelocity.z += velVasoX * 0.3;
  });
}

function aplicarFuerzaCentrifuga() {
  if (estadoActual !== ESTADOS.AGITANDO) return;

  const velocidadOrbital = 3 + agitacionAmplitud * 6;
  const omegaCuadrado = velocidadOrbital * velocidadOrbital;

  dados.forEach(d => {
    const dentroVaso = d.body.position.y > vasoYActual - VASO_ALTURA / 2 &&
                       d.body.position.y < vasoYActual + VASO_ALTURA / 2;
    if (!dentroVaso) return;

    const dx = d.body.position.x - vasoGroup.position.x;
    const dz = d.body.position.z - vasoGroup.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.1) return;

    const haciaFueraX = dx / dist;
    const haciaFueraZ = dz / dist;
    const fuerzaCentrifuga = DADO_MASA * omegaCuadrado * dist * FACTOR_CENTRIFUGA * 0.05;

    d.body.applyForce(
      new CANNON.Vec3(haciaFueraX * fuerzaCentrifuga, 0, haciaFueraZ * fuerzaCentrifuga),
      new CANNON.Vec3(0, 0, 0)
    );
  });
}

/* ============================================================
   DISPERSIÓN CORRECTIVA
   ============================================================ */
function dispersarDadosEnVaso() {
  if (estadoActual !== ESTADOS.AGITANDO) return;

  dados.forEach((d, i) => {
    const vel = d.body.velocity.length();
    const ang = d.body.angularVelocity.length();
    const dentroVaso = d.body.position.y > vasoYActual - VASO_ALTURA / 2 &&
                       d.body.position.y < vasoYActual + VASO_ALTURA / 2;

    if (!dentroVaso) return;

    const posActual = new THREE.Vector3(d.body.position.x, d.body.position.y, d.body.position.z);
    const distancia = posActual.distanceTo(ultimaPosicionDados[i]);
    if (distancia < 0.15) {
      tiempoSinMoverse[i] += 16;
    } else {
      tiempoSinMoverse[i] = 0;
      ultimaPosicionDados[i].copy(posActual);
    }

    const necesitaEmpujon = (vel < 1.5 && ang < 4.0) || tiempoSinMoverse[i] > 80;

    if (necesitaEmpujon) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const fuerzaLineal = 60 + Math.random() * 40;

      const vx = Math.sin(phi) * Math.cos(theta) * fuerzaLineal;
      const vy = Math.cos(phi) * fuerzaLineal * 0.8 + 25;
      const vz = Math.sin(phi) * Math.sin(theta) * fuerzaLineal;

      d.body.applyImpulse(new CANNON.Vec3(vx, vy, vz), new CANNON.Vec3(0, 0, 0));

      const fuerzaGiro = 90 + Math.random() * 60;
      d.body.angularVelocity.set(
        (Math.random() - 0.5) * fuerzaGiro * 2,
        (Math.random() - 0.5) * fuerzaGiro * 2,
        (Math.random() - 0.5) * fuerzaGiro * 2
      );

      tiempoSinMoverse[i] = 0;
      ultimaPosicionDados[i].copy(posActual);
    }

    const distAlCentro = Math.sqrt(
      d.body.position.x * d.body.position.x +
      d.body.position.z * d.body.position.z
    );
    if (distAlCentro > VASO_RADIO_INTERNO * 0.75 && vel < 3.0) {
      const haciaCentroX = -d.body.position.x / (distAlCentro || 1);
      const haciaCentroZ = -d.body.position.z / (distAlCentro || 1);
      const fuerza = 20 + Math.random() * 15;

      d.body.applyImpulse(
        new CANNON.Vec3(
          haciaCentroX * fuerza,
          (Math.random() - 0.3) * 12,
          haciaCentroZ * fuerza
        ),
        new CANNON.Vec3(0, 0, 0)
      );
    }

    const limiteHorizontal = VASO_RADIO_INTERNO - DADO_HALF - 0.05;
    if (distAlCentro > limiteHorizontal) {
      const factor = limiteHorizontal / distAlCentro;
      d.body.position.x *= factor;
      d.body.position.z *= factor;
    }
  });
}

/* ============================================================
   CANCELAR CICLO
   ============================================================ */
function cancelarCiclo(motivo) {
  console.warn('⚠️ Cancelando ciclo:', motivo);

  dados.forEach((d, i) => {
    const angulo = (i / NUM_DADOS) * Math.PI * 2;
    d.body.wakeUp();
    d.body.position.set(Math.cos(angulo) * 0.7, DADO_HALF + 0.1, Math.sin(angulo) * 0.7);
    d.body.quaternion.set(0, 0, 0, 1);
    d.body.velocity.set(0, 0, 0);
    d.body.angularVelocity.set(0, 0, 0);
    d.body.allowSleep = false;
    d.body.type = CANNON.Body.DYNAMIC;
  });

  vasoGroup.visible = false;
  vasoYActual = VASO_Y_OCULTO;
  vasoYObjetivo = VASO_Y_OCULTO;
  vasoGroup.position.set(0, VASO_Y_OCULTO, 0);
  vasoGroup.rotation.set(0, 0, 0);
  quitarParedesFisicasVaso();

  agitacionFase = 0;
  agitacionAmplitud = 0;
  agitacionDireccionX = 0;
  agitacionDireccionZ = 0;
  agitacionSuficienteAlcanzada = false;
  contadorAgitacionesFuertes = 0;
  velocidadVasoX = 0;
  velocidadVasoZ = 0;

  yaSeSolto = false;
  tiradaEnCurso = null;
  valoresObjetivo = [null, null, null];
  modoObjetivo = 'random';
  trayectoriaObjetivo = null;
  replayTerminado = false;
  poseViva = null;

  btnAccionTexto.textContent = 'Reintentar';
  btnAccion.querySelector('.icono').textContent = '↻';
  btnAccion.classList.add('visible');
  btnAccion.onclick = null;

  if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
  cambiarEstado(ESTADOS.ESPERANDO);
}

function mostrarBotonRecoger() {
  btnAccionTexto.textContent = 'Recoger Dados';
  btnAccion.querySelector('.icono').textContent = '↺';
  btnAccion.classList.add('visible');
  btnAccion.onclick = null;
  yaSeSolto = false;
}

/* ============================================================
   INICIAR CICLO
   ============================================================ */
function iniciarCiclo() {
  if (estadoActual !== ESTADOS.ESPERANDO && estadoActual !== ESTADOS.DADOS_QUIETOS) return;

  btnAccion.classList.remove('visible');
  hintInicial.classList.add('oculto');

  magnitudSuavizada = 0;
  magnitudMaximaReciente = 0;
  tiempoInicioAgitacion = 0;
  ultimaQuietud = 0;
  alertaMostrada = false;
  yaSeSolto = false;
  valoresObjetivo = [null, null, null];
  trayectoriaObjetivo = null;
  replayTerminado = false;
  poseViva = null;

  agitacionFase = 0;
  agitacionAmplitud = 0;
  agitacionDireccionX = 0;
  agitacionDireccionZ = 0;
  agitacionSuficienteAlcanzada = false;
  contadorAgitacionesFuertes = 0;
  velocidadVasoX = 0;
  velocidadVasoZ = 0;
  ultimaPosVasoX = 0;
  ultimaPosVasoZ = 0;

  for (let i = 0; i < NUM_DADOS; i++) {
    tiempoSinMoverse[i] = 0;
  }

  barraFill.style.width = '0%';
  barraPorcentaje.textContent = '0%';
  alertaSoltar.classList.remove('activo');
  barraTrack.classList.remove('alerta');

  crearParedesFisicasVaso();

  dados.forEach((d, i) => {
    const angulo = (i / NUM_DADOS) * Math.PI * 2;
    d.body.wakeUp();
    d.body.allowSleep = false;
    d.body.type = CANNON.Body.DYNAMIC;
    d.body.angularDamping = 0.005;
    d.body.linearDamping = 0.005;
    d.body.position.set(
      Math.cos(angulo) * 1.5,
      VASO_Y_SOBRE_MESA - 1 + i * 1.0,
      Math.sin(angulo) * 1.5
    );
    d.body.quaternion.setFromEuler(
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2
    );
    d.body.velocity.set(0, 0, 0);
    d.body.angularVelocity.set(0, 0, 0);
  });

  moverParedesVasoConShake(0, 0);

  vasoGroup.visible = true;
  vasoGroup.position.set(0, VASO_Y_OCULTO, 0);
  vasoGroup.rotation.set(0, 0, 0);
  vasoYActual = VASO_Y_OCULTO;
  vasoYObjetivo = VASO_Y_ELEVADO;
  velocidadVaso = 12;

  camTargetObjetivo.set(0, VASO_Y_ELEVADO, 0);
  camOffsetObjetivo.set(0, 9, 15);

  cambiarEstado(ESTADOS.VASO_APARECIENDO);

  setTimeout(() => {
    if (estadoActual === ESTADOS.AGITANDO && !yaSeSolto && agitacionSuficienteAlcanzada) {
      soltarDados();
    }
  }, TIEMPO_RESPALDO_AGITANDO_MS);

  activarSensores();
  if (navigator.vibrate) navigator.vibrate(30);
}

/* ============================================================
   SOLTAR DADOS
   ============================================================ */
async function soltarDados() {
  if (yaSeSolto) return;
  if (!agitacionSuficienteAlcanzada) return;

  yaSeSolto = true;
  cambiarEstado(ESTADOS.PRESIMULANDO);

  barraRevolucion.classList.remove('visible');
  alertaSoltar.classList.remove('activo');
  barraTrack.classList.remove('alerta');

  const resp = await pedirTirada();
  if (!resp.ok) {
    console.error('❌ No se pudo obtener tirada:', resp.error);
    cancelarCiclo(resp.error);
    return;
  }

  tiradaEnCurso = {
    id_tirada: resp.id_tirada,
    valores: resp.valores,
    modo: resp.modo,
    solicitud_id: resp.solicitud_id,
  };
  valoresObjetivo = resp.valores.slice();
  modoObjetivo = resp.modo;

  console.log('🎯 OBJETIVO:', valoresObjetivo, '| modo:', modoObjetivo);

  const t0 = performance.now();
  trayectoriaObjetivo = encontrarTrayectoriaQueCumple();
  const msSimulacion = performance.now() - t0;

  if (!trayectoriaObjetivo) {
    console.error('❌ Sin trayectoria válida tras', msSimulacion.toFixed(0), 'ms');
    cancelarCiclo('presimulacion_fallida');
    return;
  }

  poseViva = dados.map(d => ({
    x: d.body.position.x,
    y: d.body.position.y,
    z: d.body.position.z,
    q: new THREE.Quaternion(
      d.body.quaternion.x, d.body.quaternion.y,
      d.body.quaternion.z, d.body.quaternion.w
    ),
  }));

  quitarParedesFisicasVaso();

  duracionFrameReplay = PASO_SIMULACION * PASO_GRABACION;
  tiempoInicioReplay = performance.now();
  replayTerminado = false;

  cambiarEstado(ESTADOS.DADOS_CAYENDO);

  /* ⚡ El vaso sube rápido PERO conserva su órbita (ver actualizarVaso) */
  vasoYObjetivo = VASO_Y_ELEVADO + 4.0;
  velocidadVaso = VELOCIDAD_SUBIDA_VASO_SUELTA;

  if (navigator.vibrate) navigator.vibrate([25, 30, 25]);
}

/* ============================================================
   FINALIZAR
   ============================================================ */
async function finalizarLanzamiento() {
  if (estadoActual === ESTADOS.DADOS_QUIETOS) return;

  if (trayectoriaObjetivo) {
    aplicarFrameFinal(trayectoriaObjetivo.length - 1);
  }

  const mostrados = dados.map(d => caraSuperior(d.body) + 1);
  console.log('✅ TIRADA FINAL:', mostrados, '| objetivo:', valoresObjetivo);

  cambiarEstado(ESTADOS.DADOS_QUIETOS);
  sincronizar();
  mostrarBotonRecoger();

  if (!tiradaEnCurso) return;

  const rep = await reportarResultado(tiradaEnCurso.id_tirada, mostrados);
  if (!rep.ok) {
    console.warn('⚠️ Reporte falló:', rep.error);
  }
  tiradaEnCurso = null;
  trayectoriaObjetivo = null;
  replayTerminado = false;
  poseViva = null;
}

/* ============================================================
   RECOGER
   ============================================================ */
function recogerDados() {
  btnAccion.classList.remove('visible');
  btnAccion.onclick = null;
  yaSeSolto = false;
  iniciarCiclo();
}

/* ============================================================
   ACTUALIZAR VASO
   ⚡ El vaso mantiene su órbita mientras sube al soltar
   ============================================================ */
function actualizarVaso(dt) {
  const diff = vasoYObjetivo - vasoYActual;
  vasoYActual += diff * Math.min(dt * velocidadVaso, 1);
  vasoGroup.position.y = vasoYActual;

  const posAnteriorX = ultimaPosVasoX;
  const posAnteriorZ = ultimaPosVasoZ;

  if (estadoActual === ESTADOS.AGITANDO) {
    const intensidad = Math.min(magnitudSuavizada / UMBRAL_MOVIMIENTO_MAX, 1);
    agitacionAmplitud += (intensidad - agitacionAmplitud) * Math.min(dt * 3, 1);

    agitacionFase += dt * (3 + agitacionAmplitud * 6);
    const radio = 0.15 + agitacionAmplitud * 0.40;

    const orbitaBaseX = Math.cos(agitacionFase) * radio;
    const orbitaBaseZ = Math.sin(agitacionFase) * radio;

    const desplazamiento = agitacionAmplitud * 0.35;
    vasoGroup.position.x = orbitaBaseX + agitacionDireccionX * desplazamiento;
    vasoGroup.position.z = orbitaBaseZ + agitacionDireccionZ * desplazamiento;

    vasoGroup.rotation.x = Math.sin(agitacionFase * 0.8) * agitacionAmplitud * 0.18
                         + agitacionDireccionZ * agitacionAmplitud * 0.25;
    vasoGroup.rotation.z = Math.cos(agitacionFase * 1.1) * agitacionAmplitud * 0.18
                         - agitacionDireccionX * agitacionAmplitud * 0.25;

    velocidadVasoX = (vasoGroup.position.x - posAnteriorX) / Math.max(dt, 0.001);
    velocidadVasoZ = (vasoGroup.position.z - posAnteriorZ) / Math.max(dt, 0.001);
    velocidadVasoX = Math.max(-50, Math.min(50, velocidadVasoX));
    velocidadVasoZ = Math.max(-50, Math.min(50, velocidadVasoZ));

    ultimaPosVasoX = vasoGroup.position.x;
    ultimaPosVasoZ = vasoGroup.position.z;

    moverParedesVasoConShake(vasoGroup.position.x, vasoGroup.position.z);

  } else {
    /* ⚡ MANTENER LA ÓRBITA mientras el vaso sube (no centrar de golpe) */
    agitacionAmplitud *= 0.90;

    /* Sigue girando en órbita mientras sube */
    agitacionFase += dt * (3 + agitacionAmplitud * 6);
    const radio = 0.15 + agitacionAmplitud * 0.40;
    const orbitaBaseX = Math.cos(agitacionFase) * radio;
    const orbitaBaseZ = Math.sin(agitacionFase) * radio;

    /* Interpolación suave: el vaso va hacia esa órbita reducida */
    vasoGroup.position.x += (orbitaBaseX - vasoGroup.position.x) * Math.min(dt * 1.5, 1);
    vasoGroup.position.z += (orbitaBaseZ - vasoGroup.position.z) * Math.min(dt * 1.5, 1);

    /* Inclinación pendular que se va apagando */
    vasoGroup.rotation.x *= 0.94;
    vasoGroup.rotation.z *= 0.94;

    velocidadVasoX *= 0.85;
    velocidadVasoZ *= 0.85;
    ultimaPosVasoX = vasoGroup.position.x;
    ultimaPosVasoZ = vasoGroup.position.z;

    moverParedesVasoConShake(vasoGroup.position.x, vasoGroup.position.z);

    /* Ocultar el vaso cuando sube suficiente */
    if (vasoGroup.visible && vasoYActual > VASO_Y_ELEVADO + 3.0) {
      vasoGroup.visible = false;
    }
  }

  if (estadoActual === ESTADOS.VASO_APARECIENDO) {
    if (Math.abs(vasoYActual - VASO_Y_ELEVADO) < 0.3) {
      cambiarEstado(ESTADOS.AGITANDO);
      tiempoInicioAgitacion = performance.now();
      agitacionFase = 0;
      agitacionAmplitud = 0;
      ultimaPosVasoX = vasoGroup.position.x;
      ultimaPosVasoZ = vasoGroup.position.z;
      barraRevolucion.classList.add('visible');
    }
  }
}

/* ============================================================
   CÁMARA
   ============================================================ */
function ajustarCamaraParaDados() {
  boundingBox3D.makeEmpty();
  dados.forEach(d => boundingBox3D.expandByPoint(d.mesh.position));

  const centro = boundingBox3D.getCenter(new THREE.Vector3());
  const size = boundingBox3D.getSize(new THREE.Vector3());
  const radio = Math.max(size.length() * 0.85 + DADO_HALF * 1.5, 3.2);

  const aspect = camera.aspect;
  const fov = camera.fov * Math.PI / 180;
  const fovH = 2 * Math.atan(Math.tan(fov / 2) * aspect);
  const distV = radio / Math.tan(fov / 2);
  const distH = radio / Math.tan(fovH / 2);
  const distancia = Math.max(distV, distH) * 1.25;

  camOffsetObjetivo.set(0, distancia * 0.62, distancia * 0.9);
  camTargetObjetivo.lerp(centro, 0.08);
}

function actualizarCamara() {
  switch (estadoActual) {
    case ESTADOS.ESPERANDO:
    case ESTADOS.DADOS_QUIETOS:
    case ESTADOS.DADOS_CAYENDO:
      ajustarCamaraParaDados();
      break;

    case ESTADOS.VASO_APARECIENDO:
    case ESTADOS.AGITANDO:
    case ESTADOS.PRESIMULANDO:
      camTargetObjetivo.lerp(new THREE.Vector3(0, vasoYActual, 0), 0.08);
      camOffsetObjetivo.set(0, 9, 15);
      break;
  }

  controls.target.lerp(camTargetObjetivo, 0.08);
  controls.update();

  tiltSuavX = THREE.MathUtils.lerp(tiltSuavX, tiltX, 0.05);
  mesaMesh.rotation.z = tiltSuavX * 0.008;
}

/* ============================================================
   BARRA
   ============================================================ */
function actualizarBarraRevolucion() {
  if (estadoActual !== ESTADOS.AGITANDO) return;

  const porcentaje = Math.min(magnitudSuavizada / UMBRAL_MOVIMIENTO_MAX, 1) * 100;
  barraFill.style.width = porcentaje + '%';
  barraPorcentaje.textContent = Math.round(porcentaje) + '%';

  const ahora = performance.now();
  const tiempoAgitando = ahora - tiempoInicioAgitacion;

  const agitacionAlMaximo =
    magnitudMaximaReciente >= UMBRAL_ALERTA_SUELTA &&
    magnitudSuavizada >= UMBRAL_ALERTA_SUELTA;

  const listoParaMostrarAlerta = agitacionAlMaximo && tiempoAgitando > TIEMPO_MIN_AGITACION;

  if (listoParaMostrarAlerta && !alertaMostrada) {
    alertaMostrada = true;
    alertaSoltar.classList.add('activo');
    barraTrack.classList.add('alerta');
    if (navigator.vibrate) navigator.vibrate([15, 40, 15]);
  } else if (!listoParaMostrarAlerta && alertaMostrada) {
    alertaMostrada = false;
    alertaSoltar.classList.remove('activo');
    barraTrack.classList.remove('alerta');
  }
}

/* ============================================================
   ACELERÓMETRO
   ============================================================ */
function manejarMovimiento(e) {
  const acc = e.accelerationIncludingGravity || e.acceleration;
  if (!acc) return;

  if (e.accelerationIncludingGravity) {
    const gy = e.accelerationIncludingGravity.y || 0;
    tiltX = Math.max(-6, Math.min(6, gy * 0.4));
  }

  const ahora = performance.now();
  const dx = (acc.x || 0) - ultimoAcc.x;
  const dy = (acc.y || 0) - ultimoAcc.y;
  const dz = (acc.z || 0) - ultimoAcc.z;
  const delta = Math.sqrt(dx * dx + dy * dy + dz * dz);

  ultimoAcc = { x: acc.x || 0, y: acc.y || 0, z: acc.z || 0 };
  magnitudSuavizada = magnitudSuavizada * 0.55 + delta * 0.45;

  if (estadoActual !== ESTADOS.AGITANDO) return;

  if (delta > UMBRAL_AGITACION_MINIMA) {
    contadorAgitacionesFuertes++;
    if (contadorAgitacionesFuertes >= INTENTOS_MINIMOS_AGITACION) {
      agitacionSuficienteAlcanzada = true;
    }
  }

  agitacionDireccionX += ((acc.x || 0) * 0.05 - agitacionDireccionX) * 0.15;
  agitacionDireccionZ += ((acc.z || 0) * 0.05 - agitacionDireccionZ) * 0.15;
  agitacionDireccionX = Math.max(-1, Math.min(1, agitacionDireccionX));
  agitacionDireccionZ = Math.max(-1, Math.min(1, agitacionDireccionZ));

  if (delta > UMBRAL_AGITAR * 0.3) {
    ultimaQuietud = 0;
    if (magnitudSuavizada > magnitudMaximaReciente) {
      magnitudMaximaReciente = magnitudSuavizada;
    }

    const intensidad = Math.min(delta / 6, 5.0);
    const fuerzaBase = 55 + intensidad * 100;
    const fuerzaVertical = 45 + intensidad * 65;
    const giroMax = 100 + intensidad * 150;

    dados.forEach(d => {
      d.body.wakeUp();
      d.body.allowSleep = false;

      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const vx = Math.sin(phi) * Math.cos(theta) * fuerzaBase + (acc.x || 0) * 8;
      const vy = Math.cos(phi) * fuerzaVertical * 0.5 + 22 + (acc.y || 0) * 5;
      const vz = Math.sin(phi) * Math.sin(theta) * fuerzaBase + (acc.z || 0) * 8;

      d.body.applyImpulse(new CANNON.Vec3(vx, vy, vz), new CANNON.Vec3(0, 0, 0));

      d.body.angularVelocity.set(
        (Math.random() - 0.5) * giroMax,
        (Math.random() - 0.5) * giroMax,
        (Math.random() - 0.5) * giroMax
      );
    });
  }

  const deltaBajo = delta < UMBRAL_AGITAR * 0.5;
  if (deltaBajo) {
    if (ultimaQuietud === 0) ultimaQuietud = ahora;
    if (ahora - ultimaQuietud > TIEMPO_QUIETUD_MOVIL_MS) {
      soltarDados();
    }
  } else {
    ultimaQuietud = 0;
  }
}

async function activarSensores() {
  if (acelerometroActivo) return;
  try {
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      const permiso = await DeviceMotionEvent.requestPermission();
      if (permiso === 'granted') {
        window.addEventListener('devicemotion', manejarMovimiento);
        acelerometroActivo = true;
      }
    } else if (window.DeviceMotionEvent) {
      window.addEventListener('devicemotion', manejarMovimiento);
      acelerometroActivo = true;
    }
  } catch (err) {
    console.warn('Sensores no disponibles:', err);
  }
}

/* ============================================================
   SIMULACIÓN DESKTOP
   ============================================================ */
function simularAgitacion() {
  const checkEstado = setInterval(() => {
    if (estadoActual === ESTADOS.AGITANDO) {
      clearInterval(checkEstado);
      const inicio = performance.now();
      const duracion = 2200;

      const intervalo = setInterval(() => {
        const t = performance.now() - inicio;
        if (t > duracion) { clearInterval(intervalo); return; }

        const progreso = t / duracion;
        let nivel;
        if (progreso < 0.7) nivel = 26 * (progreso / 0.7);
        else nivel = 26 * (1 - (progreso - 0.7) / 0.3);

        magnitudSuavizada = nivel;
        magnitudMaximaReciente = Math.max(magnitudMaximaReciente, magnitudSuavizada);

        agitacionDireccionX = Math.sin(performance.now() * 0.001) * 0.5;
        agitacionDireccionZ = Math.cos(performance.now() * 0.0013) * 0.5;

        if (nivel > UMBRAL_AGITACION_MINIMA) {
          contadorAgitacionesFuertes++;
          if (contadorAgitacionesFuertes >= INTENTOS_MINIMOS_AGITACION) {
            agitacionSuficienteAlcanzada = true;
          }
        }

        const intensidad = Math.min(nivel / 6, 5.0);
        const fuerzaBase = 55 + intensidad * 100;
        const fuerzaV = 45 + intensidad * 65;
        const giroMax = 100 + intensidad * 150;

        dados.forEach(d => {
          d.body.wakeUp();
          d.body.allowSleep = false;

          const theta = Math.random() * Math.PI * 2;
          const phi = Math.acos(2 * Math.random() - 1);
          const vx = Math.sin(phi) * Math.cos(theta) * fuerzaBase;
          const vy = Math.cos(phi) * fuerzaV * 0.5 + 22;
          const vz = Math.sin(phi) * Math.sin(theta) * fuerzaBase;

          d.body.applyImpulse(new CANNON.Vec3(vx, vy, vz), new CANNON.Vec3(0, 0, 0));

          d.body.angularVelocity.set(
            (Math.random() - 0.5) * giroMax,
            (Math.random() - 0.5) * giroMax,
            (Math.random() - 0.5) * giroMax
          );
        });

        if (t > 1200 && !alertaMostrada) {
          alertaMostrada = true;
          alertaSoltar.classList.add('activo');
          barraTrack.classList.add('alerta');
        }
      }, 40);

      setTimeout(() => {
        if (estadoActual === ESTADOS.AGITANDO && agitacionSuficienteAlcanzada) soltarDados();
      }, duracion + 100);
    }
  }, 80);
}

/* ============================================================
   INIT
   ============================================================ */
function init() {
  initThree();
  initLuces();
  initPhysics();
  crearMesa();
  crearVaso();
  crearTodosLosDados();

  btnAccionTexto.textContent = 'Tirar Dados';
  btnAccion.querySelector('.icono').textContent = '🎲';
  btnAccion.classList.add('visible');
  cambiarEstado(ESTADOS.ESPERANDO);

  btnAccion.addEventListener('click', (e) => {
    e.stopPropagation();
    activarSensores();
    if (estadoActual === ESTADOS.DADOS_QUIETOS) {
      recogerDados();
    } else if (estadoActual === ESTADOS.ESPERANDO) {
      iniciarCiclo();
      setTimeout(() => {
        if (!acelerometroActivo &&
            (estadoActual === ESTADOS.VASO_APARECIENDO || estadoActual === ESTADOS.AGITANDO)) {
          simularAgitacion();
        }
      }, 400);
    }
  });

  window.addEventListener('touchstart', () => activarSensores(), { once: true });
  window.addEventListener('click', () => activarSensores(), { once: true });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      activarSensores();
      if (estadoActual === ESTADOS.DADOS_QUIETOS) {
        recogerDados();
      } else if (estadoActual === ESTADOS.ESPERANDO) {
        iniciarCiclo();
        setTimeout(() => {
          if (!acelerometroActivo &&
              (estadoActual === ESTADOS.VASO_APARECIENDO || estadoActual === ESTADOS.AGITANDO)) {
            simularAgitacion();
          }
        }, 400);
      }
    }
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  animate();
}

/* ============================================================
   LOOP
   ============================================================ */
let lastTime = performance.now() / 1000;

function animate() {
  requestAnimationFrame(animate);

  const time = performance.now() / 1000;
  const dt = Math.min(time - lastTime, 0.05);
  lastTime = time;

  if (estadoActual === ESTADOS.DADOS_CAYENDO) {
    const termino = avanzarReplay();
    if (termino && !replayTerminado) {
      replayTerminado = true;
      finalizarLanzamiento();
    }
  } else if (estadoActual !== ESTADOS.DADOS_QUIETOS && estadoActual !== ESTADOS.PRESIMULANDO) {
    if (estadoActual === ESTADOS.AGITANDO) {
      aplicarInerciaDelVaso();
      aplicarFuerzaCentrifuga();
    }
    world.step(1 / 120, dt, 8);
    corregirDadosCaidos();
  }

  sincronizar();
  actualizarVaso(dt);
  actualizarCamara();
  actualizarBarraRevolucion();

  if (estadoActual === ESTADOS.AGITANDO) {
    dados.forEach(d => d.body.wakeUp());
    dispersarDadosEnVaso();
  }

  if (estadoActual === ESTADOS.AGITANDO && tiempoInicioAgitacion > 0) {
    const tiempoAgitando = performance.now() - tiempoInicioAgitacion;
    if (tiempoAgitando > TIEMPO_GUARDIAN_AGITANDO_MS && !yaSeSolto && agitacionSuficienteAlcanzada) {
      soltarDados();
    }
  }

  renderer.render(scene, camera);
}

init();