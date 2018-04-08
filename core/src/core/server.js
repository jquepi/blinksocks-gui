const fs = require('fs');
const path = require('path');
const http = require('http');
const utils = require('util');
const Koa = require('koa');
const KoaRouter = require('koa-router');
const staticCache = require('koa-static-cache');
const favicon = require('koa-favicon');
const bodyParser = require('koa-bodyparser');
const _ = require('lodash');

const readdir = utils.promisify(fs.readdir);

const {
  RUNTIME_LOG_PATH,
  RUN_TYPE_CLIENT,
  RUN_TYPE_SERVER,
  HASH_SALT,
} = require('../constants');

const Router = require('./router');
const { hash, logger, db, import_dir } = require('../utils');

const ALL_METHODS = Object.assign(
  {},
  import_dir(path.resolve(__dirname, '../methods')),
  import_dir(path.resolve(__dirname, '../lives')),
);

function onConnection(socket, { runType }) {
  const { user, address } = socket.handshake;
  logger.verbose(`[${address}] connected`);

  function extendDB(db) {
    db.getConfigs = () => {
      const key = {
        [RUN_TYPE_CLIENT]: 'client_configs',
        [RUN_TYPE_SERVER]: 'server_configs',
      }[runType];
      return db.get(key);
    };
    return db;
  }

  const thisArg = {
    ctx: {
      runType,
      push_handlers: {}, // used by _xxx_server_push().
    },
    user: user || null,
    db: extendDB(db),
    getConfigurableMethods() {
      const methods = _.transform(ALL_METHODS, (result, _, key) => result.push(key), []);
      return methods.filter((name) => name[0] !== '_');
    },
    getDisallowedMethods() {
      return user['disallowed_methods'] || [];
    },
    push(event, data) {
      logger.info(`[${address}] [PUSH] ${JSON.stringify(data)}`);
      socket.emit(event, data);
    },
    invoke(method, args, extra) {
      return Router.dispatch.call(thisArg, method, args, extra);
    },
  };

  // handle client requests
  socket.on('request', async function (req, send) {
    const reqStr = JSON.stringify(req);
    logger.info(`[${address}] request => ${reqStr}`);
    const { method, args } = req;
    try {
      const result = await Router.dispatch.call(thisArg, method, args);
      const response = { code: 0 };
      if (result !== null) {
        response.data = result;
      }
      logger.info(`[${address}] response => ${JSON.stringify(response)}`);
      send(response);
    } catch (err) {
      logger.error(`[${address}] cannot process the request: ${reqStr}, %s`, err.stack);
      send({ code: -1, message: err.message });
    }
  });

  socket.on('disconnect', async function () {
    logger.verbose(`[${address}] disconnected`);
    try {
      const { push_handlers } = thisArg.ctx;
      for (const key of Object.keys(push_handlers)) {
        await push_handlers[key].dispose();
      }
    } catch (err) {
      // ignore any errors
      // console.log(err);
    }
  });
}

function createWrappedUsers() {
  return db.get('users').value()
    .map((user) => Object.assign({
      token: hash('SHA-256', user.password + HASH_SALT),
    }, user));
}

module.exports = async function startServer(args) {
  const { runType, port } = args;

  // start koa server
  const app = new Koa();
  const router = new KoaRouter();
  const server = http.createServer(app.callback());
  const io = require('socket.io')(server);

  // ws authentication middleware
  io.use((socket, next) => {
    const { query: { token } } = socket.handshake;
    const user = createWrappedUsers().find((user) => user.token === token);
    if (user) {
      // NOTE: put user to socket.handshake so that
      // we can access it again in onConnection().
      socket.handshake.user = user;
      return next();
    }
    return next(new Error('authentication error'));
  });

  // handle ws connections
  io.on('connection', (socket) => onConnection(socket, args));

  // standalone http interface
  router.post('/verify', async (ctx) => {
    const { token } = ctx.request.body;
    if (!createWrappedUsers().find((user) => user.token === token)) {
      return ctx.throw(403, 'authentication error');
    }
    ctx.status = 200;
  });
  router.get('/logs/:id', async (ctx) => {
    const { id } = ctx.params;
    if (!/[0-9a-z\-]{36}/.test(id)) {
      return ctx.throw(400, 'invalid parameter');
    }
    const files = await readdir(RUNTIME_LOG_PATH);
    const logFiles = files
      .filter(name => name.startsWith(id + '.log'))
      .sort()
      .map(name => path.join(RUNTIME_LOG_PATH, name));

    const logFile = logFiles[0] || '';
    if (!logFile) {
      return ctx.throw(404);
    }
    ctx.set('content-type', 'text/plain');
    ctx.body = fs.createReadStream(logFile);
  });

  const publicPath = path.join(__dirname, '../../public');
  app.use(favicon(path.join(publicPath, 'favicon.ico')));
  app.use(staticCache(publicPath, {
    alias: {
      '/': '/index.html',
      '/landing': '/index.html',
    },
  }));
  app.use(bodyParser());
  app.use(router.routes());
  app.use(router.allowedMethods());

  const _port = port || 3000;
  server.listen(_port, () => {
    logger.info(`blinksocks gui ${runType === RUN_TYPE_SERVER ? 'server' : 'client'} is running at ${_port}.`);
    logger.info('You can now open blinksocks-gui in browser:');
    console.log('');
    console.log(`  http://localhost:${_port}/`);
    console.log('');
  });
};
