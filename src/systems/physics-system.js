import { AmmoWorker, WorkerHelpers, CONSTANTS } from "three-ammo";
import { AmmoDebugConstants, DefaultBufferSize } from "ammo-debug-drawer";
import configs from "../utils/configs";
import * as ammoWasmUrl from "ammo.js/builds/ammo.wasm.wasm";

const MESSAGE_TYPES = CONSTANTS.MESSAGE_TYPES,
  TYPE = CONSTANTS.TYPE,
  BUFFER_CONFIG = CONSTANTS.BUFFER_CONFIG;

const WORLD_CONFIG = {
  debugDrawMode: AmmoDebugConstants.DrawWireframe,
  gravity: { x: 0, y: -9.8, z: 0 }
};

export class PhysicsSystem {
  constructor(scene) {
    this.ammoWorker = new AmmoWorker();
    this.workerHelpers = new WorkerHelpers(this.ammoWorker);

    this.bodyHelpers = [];
    this.shapeHelpers = [];

    this.bodyUuids = [];
    this.uuidToIndex = {};
    this.indexToUuid = {};
    this.object3Ds = {};
    window.object3Ds = this.object3Ds;
    this.bodyOptions = {};
    this.bodyLinearVelocities = {};
    this.bodyAngularVelocities = {};

    this.shapeUuids = [];
    this.shapes = {};

    this.collisions = {};

    this.constraints = {};

    this.debugRequested = false;
    this.debugEnabled = false;
    this.scene = scene;
    this.stepDuration = 0;

    this.ready = false;
    this.nextBodyUuid = 0;
    this.nextShapeUuid = 0;

    const arrayBuffer = new ArrayBuffer(4 * BUFFER_CONFIG.BODY_DATA_SIZE * BUFFER_CONFIG.MAX_BODIES);
    this.objectMatricesFloatArray = new Float32Array(arrayBuffer);
    this.objectMatricesIntArray = new Int32Array(arrayBuffer);

    this.ammoWorker.postMessage(
      {
        type: MESSAGE_TYPES.INIT,
        worldConfig: WORLD_CONFIG,
        arrayBuffer,
        wasmUrl: new URL(ammoWasmUrl, configs.BASE_ASSETS_PATH || window.location).href
      },
      [arrayBuffer]
    );

    this.ammoWorker.onmessage = async event => {
      if (event.data.type === MESSAGE_TYPES.READY) {
        this.ready = true;
        for (const bodyHelper of this.bodyHelpers) {
          if (bodyHelper.alive) bodyHelper.init2();
        }
        for (const shapeHelper of this.shapeHelpers) {
          if (shapeHelper.alive) shapeHelper.init2();
        }
        this.shapeHelpers.length = 0;
        this.bodyHelpers.length = 0;
      } else if (event.data.type === MESSAGE_TYPES.BODY_READY) {
        const uuid = event.data.uuid;
        const index = event.data.index;
        this.bodyUuids.push(uuid);
        this.uuidToIndex[uuid] = index;
        this.indexToUuid[index] = uuid;
      } else if (event.data.type === MESSAGE_TYPES.SHAPES_READY) {
        const bodyUuid = event.data.bodyUuid;
        const shapesUuid = event.data.shapesUuid;
        this.shapes[bodyUuid].push(shapesUuid);
      } else if (event.data.type === MESSAGE_TYPES.TRANSFER_DATA) {
        this.objectMatricesFloatArray = event.data.objectMatricesFloatArray;
        this.objectMatricesIntArray = new Int32Array(this.objectMatricesFloatArray.buffer);
        this.stepDuration = event.data.stepDuration;
      }
    };
  }

  setDebug(debug) {
    this.debugRequested = debug;
  }

  enableDebug() {
    if (!window.SharedArrayBuffer) {
      console.warn("Physics debug rendering only available in browsers that support SharedArrayBuffers.");
      this.debugRequested = false;
      return;
    }

    this.debugEnabled = true;

    if (!this.debugMesh) {
      this.debugSharedArrayBuffer = new window.SharedArrayBuffer(4 + 2 * DefaultBufferSize * 4);
      this.debugIndex = new Uint32Array(this.debugSharedArrayBuffer, 0, 4);
      const debugVertices = new Float32Array(this.debugSharedArrayBuffer, 4, DefaultBufferSize);
      const debugColors = new Float32Array(this.debugSharedArrayBuffer, 4 + DefaultBufferSize, DefaultBufferSize);
      this.debugGeometry = new THREE.BufferGeometry();
      this.debugGeometry.addAttribute("position", new THREE.BufferAttribute(debugVertices, 3));
      this.debugGeometry.addAttribute("color", new THREE.BufferAttribute(debugColors, 3));
      const debugMaterial = new THREE.LineBasicMaterial({
        vertexColors: THREE.VertexColors,
        depthTest: true
      });
      this.debugMesh = new THREE.LineSegments(this.debugGeometry, debugMaterial);
      this.debugMesh.frustumCulled = false;
      this.debugMesh.renderOrder = 999;
    }

    if (!this.debugMesh.parent) {
      this.scene.add(this.debugMesh);
      this.workerHelpers.enableDebug(true, this.debugSharedArrayBuffer);
    }
  }

  disableDebug() {
    this.debugEnabled = false;
    if (this.debugMesh) {
      this.scene.remove(this.debugMesh);
      this.workerHelpers.enableDebug(false);
    }
  }

  tick = (() => {
    const transform = new THREE.Matrix4();
    const inverse = new THREE.Matrix4();
    const matrix = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    return function() {
      if (this.ready) {
        if (this.debugRequested !== this.debugEnabled) {
          if (this.debugRequested) {
            this.enableDebug();
          } else {
            this.disableDebug();
          }
        }

        /** Buffer Schema
         * Every physics body has 26 * 4 bytes (64bit float/int) assigned in the buffer
         * 0-15   Matrix4 elements (floats)
         * 16     Linear Velocity (float)
         * 17     Angular Velocity (float)
         * 18-25  first 8 Collisions (ints)
         */

        if (this.objectMatricesFloatArray.buffer.byteLength !== 0) {
          for (let i = 0; i < this.bodyUuids.length; i++) {
            const uuid = this.bodyUuids[i];
            const index = this.uuidToIndex[uuid];
            const type = this.bodyOptions[uuid].type ? this.bodyOptions[uuid].type : TYPE.DYNAMIC;
            const object3D = this.object3Ds[uuid];
            if (type === TYPE.DYNAMIC) {
              matrix.fromArray(this.objectMatricesFloatArray, index * BUFFER_CONFIG.BODY_DATA_SIZE);
              inverse.getInverse(object3D.parent.matrixWorld);
              transform.multiplyMatrices(inverse, matrix);
              transform.decompose(object3D.position, object3D.quaternion, scale);
            }

            object3D.updateMatrices();
            this.objectMatricesFloatArray.set(object3D.matrixWorld.elements, index * BUFFER_CONFIG.BODY_DATA_SIZE);

            if (this.bodyLinearVelocities.hasOwnProperty(uuid)) {
              this.bodyLinearVelocities[uuid] = this.objectMatricesFloatArray[
                index * BUFFER_CONFIG.BODY_DATA_SIZE + 16
              ];
            }
            if (this.bodyAngularVelocities.hasOwnProperty(uuid)) {
              this.bodyAngularVelocities[uuid] = this.objectMatricesFloatArray[
                index * BUFFER_CONFIG.BODY_DATA_SIZE + 17
              ];
            }

            this.collisions[uuid].length = 0;

            for (let j = 18; j < BUFFER_CONFIG.BODY_DATA_SIZE; j++) {
              const collidingIndex = this.objectMatricesIntArray[index * BUFFER_CONFIG.BODY_DATA_SIZE + j];
              if (collidingIndex !== -1) {
                this.collisions[uuid].push(this.indexToUuid[collidingIndex]);
              }
            }
          }

          this.ammoWorker.postMessage(
            { type: MESSAGE_TYPES.TRANSFER_DATA, objectMatricesFloatArray: this.objectMatricesFloatArray },
            [this.objectMatricesFloatArray.buffer]
          );
        }

        /* DEBUG RENDERING */
        if (this.debugEnabled) {
          const index = window.Atomics.load(this.debugIndex, 0);
          if (index !== 0) {
            this.debugGeometry.attributes.position.needsUpdate = true;
            this.debugGeometry.attributes.color.needsUpdate = true;
          }
          this.debugGeometry.setDrawRange(0, index);
          window.Atomics.store(this.debugIndex, 0, 0);
        }
      }
    };
  })();

  addBody(object3D, options) {
    this.workerHelpers.addBody(this.nextBodyUuid, object3D, options);
    this.object3Ds[this.nextBodyUuid] = object3D;
    this.bodyOptions[this.nextBodyUuid] = options;
    this.collisions[this.nextBodyUuid] = [];
    this.bodyLinearVelocities[this.nextBodyUuid] = 0;
    this.bodyAngularVelocities[this.nextBodyUuid] = 0;
    return this.nextBodyUuid++;
  }

  updateBody(uuid, options) {
    this.bodyOptions[uuid] = options;
    this.workerHelpers.updateBody(uuid, options);
  }

  removeBody(uuid) {
    delete this.indexToUuid[this.uuidToIndex[uuid]];
    delete this.uuidToIndex[uuid];
    delete this.object3Ds[uuid];
    delete this.bodyOptions[uuid];
    delete this.collisions[uuid];
    delete this.bodyLinearVelocities[uuid];
    delete this.bodyAngularVelocities[uuid];
    const idx = this.bodyUuids.indexOf(uuid);
    if (idx !== -1) {
      this.bodyUuids.splice(idx, 1);
    }
    this.workerHelpers.removeBody(uuid);
  }

  addShapes(bodyUuid, mesh, options) {
    if (mesh) {
      const scale = new THREE.Vector3();
      scale.setFromMatrixScale(mesh.matrixWorld);
    }
    this.workerHelpers.addShapes(bodyUuid, this.nextShapeUuid, mesh, options);
    if (!this.shapes[bodyUuid]) {
      this.shapes[bodyUuid] = [];
    }
    this.shapes[bodyUuid].push(this.nextShapeUuid);
    return this.nextShapeUuid++;
  }

  removeShapes(bodyUuid, shapesUuid) {
    this.workerHelpers.removeShapes(bodyUuid, shapesUuid);
    if (this.shapes.bodyUuid) {
      const idx = this.shapes[bodyUuid].indexOf(shapesUuid);
      if (idx !== -1) {
        this.shapes[bodyUuid].splice(idx, 1);
      }
    }
  }

  addConstraint(constraintId, bodyUuid, targetUuid, options) {
    this.workerHelpers.addConstraint(constraintId, bodyUuid, targetUuid, options);
  }

  removeConstraint(constraintId) {
    this.workerHelpers.removeConstraint(constraintId);
  }

  registerBodyHelper(bodyHelper) {
    if (this.ready) {
      bodyHelper.init2();
    } else {
      this.bodyHelpers.push(bodyHelper);
    }
  }

  registerShapeHelper(shapeHelper) {
    if (this.ready) {
      shapeHelper.init2();
    } else {
      this.shapeHelpers.push(shapeHelper);
    }
  }

  bodyInitialized(uuid) {
    return !!this.uuidToIndex[uuid];
  }

  getLinearVelocity(uuid) {
    return this.bodyLinearVelocities[uuid];
  }

  getAngularVelocity(uuid) {
    return this.bodyAngularVelocities[uuid];
  }

  resetDynamicBody(uuid) {
    this.workerHelpers.resetDynamicBody(uuid);
  }

  activateBody(uuid) {
    this.workerHelpers.activateBody(uuid);
  }
}
