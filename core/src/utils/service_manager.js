const path = require('path');
const child_process = require('child_process');

const {
  SERVICE_STATUS_INIT,
  SERVICE_STATUS_RUNNING,
  SERVICE_STATUS_STOPPED,
} = require('../constants');

const FORK_SCRIPT = path.resolve(__dirname, '_fork.js');

const subprocesses = new Map(
  // <id>: <ChildProcess>,
);

// spawn a new sub process
function fork() {
  const subprocess = child_process.fork(FORK_SCRIPT, { silent: true });
  const messageQueue = [];

  subprocess.on('message', (message) => {
    if (typeof message !== 'object') {
      // drop non-object message
      return;
    }
    messageQueue.push(message);
  });

  async function send(action) {
    return new Promise((resolve, reject) => {
      // send message to sub process immediately
      subprocess.send(action);

      function scanQueue() {
        for (let i = 0; i < messageQueue.length; i++) {
          const message = messageQueue[i];
          // find related message from sub process
          if (message.type.indexOf(action.type) === 0) {
            const { type, payload } = message;
            if (type === action.type + '/error') {
              reject(Error(payload));
              return i;
            }
            if (type === action.type + '/done') {
              resolve(payload);
              return i;
            }
          }
        }
        return -1;
      }

      // consume messageQueue
      setImmediate(function consume() {
        const index = scanQueue();
        // if not found, continue to consume,
        if (index < 0) {
          setImmediate(consume);
        }
        // if message found, remove it from queue.
        else {
          messageQueue.splice(index, 1);
        }
      });
    });
  }

  return {
    // return original <ChildProcess>
    getProcess() {
      return subprocess;
    },
    // call any methods of forked process
    async invoke(method, args) {
      return send({ type: method, payload: args });
    },
  };
}

module.exports = {

  async start(id, config) {
    let sub = subprocesses.get(id);
    if (!sub) {
      sub = fork();
      subprocesses.set(id, sub);
    }
    try {
      await sub.invoke('start', config);
    } catch (err) {
      subprocesses.delete(id);
      throw err;
    }
  },

  async stop(id) {
    const sub = subprocesses.get(id);
    if (sub) {
      await sub.invoke('stop');
      sub.getProcess().kill();
      subprocesses.set(id, null);
    } else {
      throw Error(`service(${id}) is not found`);
    }
  },

  async getServices() {
    const services = {};
    for (const [id] of subprocesses) {
      services[id] = await this.getServiceInfo(id);
    }
    return services;
  },

  async getServiceInfo(id) {
    const sub = subprocesses.get(id);
    if (sub) {
      return {
        status: SERVICE_STATUS_RUNNING,
        ...(await sub.invoke('getStatus')),
      };
    } else {
      let status;
      if (sub === undefined) {
        status = SERVICE_STATUS_INIT;
      }
      if (sub === null) {
        status = SERVICE_STATUS_STOPPED;
      }
      return { status };
    }
  },

  async getMetrics(id, type) {
    const sub = subprocesses.get(id);
    if (sub) {
      switch (type) {
        case 'cpu':
          return await sub.invoke('getCPUMetrics');
        case 'memory':
          return await sub.invoke('getMemoryMetrics');
        case 'speed':
          return await sub.invoke('getSpeedMetrics');
        case 'connections':
          return await sub.invoke('getConnectionsMetrics');
        case 'traffic':
          return await sub.invoke('getTrafficMetrics');
        default:
          break;
      }
    } else {
      return [];
    }
  },

};
