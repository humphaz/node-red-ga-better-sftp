// index.js — log every path decision & strip leading '/'
// Works with ssh2-sftp-client ≥ v11 and Node 18+

const fs   = require('fs');
const path = require('path');
const SFTP = require('ssh2-sftp-client');

module.exports = function (RED) {
  'use strict';

  /*****************************************************************
   * CONFIG NODE (stores credentials + a reusable SFTP connection) *
   *****************************************************************/
  function SFTPCredentialsNode (config) {
    RED.nodes.createNode(this, config);
    this.host      = config.host;
    this.port      = config.port;
    this.username  = config.username;
    this.password  = config.password;
    this.key       = config.key;
    this._client   = null; // shared connection if you choose
  }

  const credSchema = {
    credentials: {
      username:   { type: 'text'     },
      password:   { type: 'password' },
      keydata:    { type: 'text'     },
      passphrase: { type: 'password' }
    }
  };

  RED.nodes.registerType('SFTP-credentials', SFTPCredentialsNode, credSchema);
  RED.nodes.registerType('sftp',               SFTPCredentialsNode, credSchema); // alias

  /************************************
   * MAIN IN/OUT NODE                 *
   ************************************/
  function SFtpInNode (n) {
    RED.nodes.createNode(this, n);

    const node = this;
    node.operation     = n.operation     || 'list';
    node.filename      = n.filename      || '';
    node.localFilename = n.localFilename || '';
    node.workdir       = n.workdir       || '.';
    node.cfg           = RED.nodes.getNode(n.sftp);

    if (!node.cfg) {
      node.error('SFTP: configuration node missing');
      return;
    }

    node.on('input', async (msg, send, done) => {
      const settings = {
        host:       msg.host       || node.cfg.host || 'localhost',
        port:       msg.port       || node.cfg.port || 22,
        username:   msg.user       || node.cfg.username || node.cfg.credentials.username,
        password:   msg.password   || node.cfg.password || node.cfg.credentials.password,
        key:        msg.key        || node.cfg.key      || node.cfg.credentials.keydata,
        passphrase: msg.passphrase || node.cfg.credentials.passphrase,
        tryKeyboard: n.tryKeyboard || false
      };

      const conOpts = {
        host: settings.host,
        port: settings.port,
        username: settings.username,
        password: settings.password,
        tryKeyboard: settings.tryKeyboard,
        debug: t => node.warn(`[ssh2] ${t}`)
      };
      if (settings.key)        conOpts.privateKey = settings.key;
      if (settings.passphrase) conOpts.passphrase = settings.passphrase;

      /* Connect or reuse */
      let sftp = node.cfg._client;
      if (!sftp) {
        node.warn(`[flow] connecting to ${conOpts.username}@${conOpts.host}:${conOpts.port}`);
        node.status({ fill: 'blue', shape: 'dot', text: 'connect' });
        sftp = new SFTP();
        await sftp.connect(conOpts);
        node.cfg._client = sftp;
        node.status({});
      }

      const posixJoin = (...a) => path.posix.join(...a);

      try {
        const workdir  = msg.workdir  || node.workdir || '.';
        const inFile   = msg.filename || node.filename;
        const prevDir  = await sftp.cwd();

        node.warn(`[paths] prevDir=${prevDir} workdir=${workdir} filename=${inFile}`);

        switch (node.operation) {
          case 'put': {
            /* Ensure directory exists */
            if (workdir !== '.' && workdir !== prevDir) {
              try { await sftp.mkdir(workdir, true); node.warn(`[put] ensured dir ${workdir}`); } catch (e) { node.warn(`[put] mkdir skipped: ${e.message}`); }
            }

            node.status({ fill: 'yellow', shape: 'dot', text: 'uploading' });

            let uploadSrc   = msg.payload;
            let remoteFile  = posixJoin(workdir, inFile);
            let expectedSz  = null; // compare after upload

            // Legacy {filename,data}
            if (uploadSrc && typeof uploadSrc === 'object' && 'data' in uploadSrc) {
              if (uploadSrc.filename) remoteFile = posixJoin(workdir, uploadSrc.filename);
              uploadSrc = uploadSrc.data;
              node.warn('[put] legacy {filename,data} detected');
            }

            // Strip leading '/'
            if (remoteFile.startsWith('/')) {
              node.warn(`[put] stripping leading / → ${remoteFile.slice(1)}`);
              remoteFile = remoteFile.slice(1);
            }

            // Decide source type & calculate size
            if (typeof uploadSrc === 'string') {
              if (fs.existsSync(uploadSrc)) {
                expectedSz = fs.statSync(uploadSrc).size;
              } else {
                node.warn('[put] treating string as content, not path');
                expectedSz = Buffer.byteLength(uploadSrc);
                uploadSrc  = Buffer.from(uploadSrc, 'utf8');
              }
            } else if (Buffer.isBuffer(uploadSrc)) {
              expectedSz = uploadSrc.length;
            } else if (uploadSrc && typeof uploadSrc.pipe === 'function') {
              // stream – size unknown
            } else if (msg.localPath) {
              expectedSz = fs.statSync(msg.localPath).size;
            }

            node.warn(`[put] final remote path = ${remoteFile}  (expect ${expectedSz ?? 'unknown'} bytes)`);

            // === perform the upload ===
            await sftp.put(uploadSrc || msg.localPath, remoteFile, { rejectOnError: true });

            /* Verify upload by stat */
            try {
              const rStat = await sftp.stat(remoteFile);
              node.warn(`[put] remote size = ${rStat.size}`);
              if (expectedSz !== null && rStat.size !== expectedSz) {
                throw new Error(`size mismatch: expected ${expectedSz}, got ${rStat.size}`);
              }
              node.status({}); // clear
              msg.payload = { ok: true, path: remoteFile, size: rStat.size };
            } catch (verifyErr) {
              node.status({ fill: 'red', shape: 'ring', text: 'failed' });
              node.warn(`[put] verify failed: ${verifyErr.message}`);
              throw verifyErr;
            }
            break; }

          case 'list':   msg.payload = await sftp.list(workdir); break;
          case 'get':    msg.payload = await sftp.get(posixJoin(workdir, inFile)); break;
          case 'delete': await sftp.delete(posixJoin(workdir, inFile)); msg.payload={deleted:inFile}; break;
          case 'mkdir':  await sftp.mkdir(workdir, false); msg.payload={created:workdir}; break;
          case 'rmdir':  await sftp.rmdir(workdir, false); msg.payload={removed:workdir}; break;
          case 'close':  await sftp.end(); node.cfg._client=null; msg.payload={closed:true}; break;
          default: throw new Error(`unknown op ${node.operation}`);
        }

        send(msg); done && done();
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
        node.warn(`[error] ${err.message}`);
        node.error(err, msg); done && done(err);
      }
    });
  }

  RED.nodes.registerType('sftp in', SFtpInNode, {
    credentials: {
      username: { type: 'text' },
      password: { type: 'password' }
    }
  });
};
