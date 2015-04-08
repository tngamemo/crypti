var Router = require('../helpers/router.js'),
	async = require('async'),
	request = require('request'),
	ip = require('ip'),
	util = require('util'),
	_ = require('underscore'),
	zlib = require('zlib'),
	RequestSanitizer = require('../helpers/request-sanitizer.js');

//private fields
var modules, library, self, private = {};

private.headers = {};
private.loaded = false;

//constructor
function Transport(cb, scope) {
	library = scope;
	self = this;
	self.__private = private;
	attachApi();

	setImmediate(cb, null, self);
}

//private methods
function attachApi() {
	var router = new Router();

	router.use(function (req, res, next) {
		if (modules && private.loaded) return next();
		res.status(500).send({success: false, error: 'loading'});
	});

	router.use(function (req, res, next) {
		var peerIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

		if (peerIp == "127.0.0.1") {
			return next();
		}

		req.sanitize(req.headers, {
			port: "int",
			os: "string?",
			'share-port': {
				int: true,
				boolean: true
			},
			version: "string?"
		}, function (err, report, headers) {
			if (err) return next(err);
			if (!report.isValid) return {status: false, error: report.issues};


			var peer = {
				ip: ip.toLong(peerIp),
				port: private.headers.port,
				state: 2,
				os: private.headers.os,
				sharePort: Number(private.headers['share-port']),
				version: private.headers.version
			};


			if (peer.port > 0 && peer.port <= 65535 && peer.version == library.config.version) {
				modules.peer.update(peer);
			}

			next();
		});

	});

	router.get('/list', function (req, res) {
		res.set(private.headers);
		modules.peer.list(100, function (err, peers) {
			return res.status(200).json({peers: !err ? peers : []});
		})
	});

	router.get("/blocks/common", function (req, res, next) {
		res.set(private.headers);

		req.sanitize("query", {
			max: "int!",
			min: "int!",
			ids: {
				required: true,
				string: true,
				array: ",",
				minLength: 1,
				maxLength: 1000
			}
		}, function (err, report, query) {
			if (err) return next(err);
			if (!report.isValid) return res.json({success: false, error: report.issue});


			var max = query.max;
			var min = query.min;
			var ids = query.ids.filter(function (id) {
				return /^\d+$/.test(id);
			});
			var escapedIds = ids.map(function (id) {
				return "'" + id + "'";
			});

			if (!escapedIds.length) {
				var peerIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
				var peerStr = peerIp ? peerIp + ":" + RequestSanitizer.int(req.headers['port']) : 'unknown';
				library.logger.log('common block request is not valid, ban 60 min', peerStr);
				modules.peer.state(ip.toLong(peerIp), RequestSanitizer.int(req.headers['port']), 0, 3600);
				return res.json({success: false, error: "ids is invalid"});
			}

			library.dbLite.query("select max(height), id, previousBlock, timestamp, lower(hex(blockSignature)) from blocks where id in (" + escapedIds.join(',') + ") and height >= $min and height <= $max", {
				"max": max,
				"min": min
			}, {
				"height": Number,
				"id": String,
				"previousBlock": String,
				"timestamp": Number,
				"blockSignature": String
			}, function (err, rows) {
				if (err) {
					return res.json({success: false, error: "Error in db"});
				}

				var commonBlock = rows.length ? rows[0] : null;
				return res.json({success: true, common: commonBlock});
			});
		});
	});

	router.get("/blocks", function (req, res) {
		res.set(private.headers);

		var lastBlockId = RequestSanitizer.string(req.query.lastBlockId);
		// get 1400+ blocks with all data (joins) from provided block id
		var blocksLimit = 1440;

		modules.blocks.loadBlocksData({
			limit: blocksLimit,
			lastId: lastBlockId
		}, {plain: true}, function (err, data) {
			res.status(200);
			if (err) {
				return res.json({blocks: ""});
			}
			res.json({blocks: data});

		});
	});

	router.post("/blocks", function (req, res) {
		res.set(private.headers);

		try {
			var block = library.logic.block.objectNormalize(req.body.block)
		} catch (e) {
			var peerIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
			var peerStr = peerIp ? peerIp + ":" + RequestSanitizer.int(req.headers['port']) : 'unknown';
			library.logger.log('transaction ' + (block ? block.id : 'null') + ' is not valid, ban 60 min', peerStr);
			modules.peer.state(ip.toLong(peerIp), RequestSanitizer.int(req.headers['port']), 0, 3600);
			return res.sendStatus(200);
		}

		library.bus.message('receiveBlock', block);

		res.sendStatus(200);
	});

	router.get("/transactions", function (req, res) {
		res.set(private.headers);
		// need to process headers from peer
		res.status(200).json({transactions: modules.transactions.getUnconfirmedTransactionList()});
	});

	router.post("/transactions", function (req, res) {
		res.set(private.headers);

		try {
			var transaction = library.logic.transaction.objectNormalize(req.body.transaction);
		} catch (e) {
			var peerIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
			var peerStr = peerIp ? peerIp + ":" + RequestSanitizer.int(req.headers['port']) : 'unknown';
			library.logger.log('transaction ' + (transaction ? transaction.id : 'null') + ' is not valid, ban 60 min', peerStr);
			modules.peer.state(ip.toLong(peerIp), RequestSanitizer.int(req.headers['port']), 0, 3600);
			return res.status(200).json({success: false, message: "Invalid transaction body"});
		}

		library.sequence.add(function (cb) {
			modules.transactions.receiveTransactions([transaction], cb);
		}, function (err) {
			if (err) {
				res.status(200).json({success: false, message: err});
			} else {
				res.status(200).json({success: true});
			}
		});
	});

	router.get('/height', function (req, res) {
		res.set(private.headers);
		res.status(200).json({
			height: modules.blocks.getLastBlock().height
		});
	});

	router.use(function (req, res, next) {
		res.status(500).send({success: false, error: 'api not found'});
	});

	library.app.use('/peer', router);

	library.app.use(function (err, req, res, next) {
		if (!err) return next();
		library.logger.error(req.url, err.toString());
		res.status(500).send({success: false, error: err.toString()});
	});
}

//public methods
Transport.prototype.broadcast = function (peersCount, options, cb) {
	peersCount = peersCount || 1;

	modules.peer.list(peersCount, function (err, peers) {
		if (!err) {
			async.eachLimit(peers, 3, function (peer, cb) {
				self.getFromPeer(peer, options);

				setImmediate(cb);
			}, function () {
				cb && cb(null, {body: null, peer: peers});
			})
		} else {
			cb && setImmediate(cb, err);
		}
	});
}

Transport.prototype.getFromRandomPeer = function (options, cb) {
	async.retry(20, function (cb) {
		modules.peer.list(1, function (err, peers) {
			if (!err && peers.length) {
				var peer = peers[0];
				self.getFromPeer(peer, options, cb);
			} else {
				return cb(err || "No peers in db");
			}
		});
	}, function (err, results) {
		cb(err, results)
	});
}

/**
 * Send request to selected peer
 * @param {object} peer Peer object
 * @param {object} options Request lib params with special value `api` which should be string name of peer's module
 * web method
 * @param {function} cb Result Callback
 * @returns {*|exports} Request lib request instance
 * @private
 * @exmplae
 *
 * // Send gzipped request to peer's web method /peer/blocks.
 * .getFromPeer(peer, {api:'/blocks', gzip:true}, function(err, data){
 * 	// process request
 * });
 */
Transport.prototype.getFromPeer = function (peer, options, cb) {
	var url;
	if (options.api) {
		url = '/peer' + options.api
	} else {
		url = options.url;
	}

	var req = {
		url: 'http://' + ip.fromLong(peer.ip) + ':' + peer.port + url,
		method: options.method,
		json: true,
		headers: _.extend({}, private.headers, options.headers),
		timeout: 5000
	};

	if (Object.prototype.toString.call(options.data) === "[object Object]" || util.isArray(options.data)) {
		req.json = options.data;
	} else {
		req.body = options.data;
	}

	return request(req, function (err, response, body) {
		if (err || response.statusCode != 200) {
			library.logger.debug('request', {
				url: req.url,
				statusCode: response ? response.statusCode : 'unknown',
				err: err
			});

			if (peer) {
				if (err && (err.code == "ETIMEDOUT" || err.code == "ESOCKETTIMEDOUT" || err.code == "ECONNREFUSED")) {
					modules.peer.remove(peer.ip, peer.port, function (err) {
						if (!err) {
							library.logger.info('remove peer ' + req.method + ' ' + req.url)
						}
					});
				} else {
					modules.peer.state(peer.ip, peer.port, 0, 600, function (err) {
						if (!err) {
							library.logger.info('ban 10 min ' + req.method + ' ' + req.url);
						}
					});
				}
			}
			cb && cb(err || ('request status code' + response.statusCode));
			return;
		}

		var port = RequestSanitizer.int(response.headers['port']);
		if (port > 0 && port <= 65535 && RequestSanitizer.string(response.headers['version'], true) == library.config.version) {
			modules.peer.update({
				ip: peer.ip,
				port: port,
				state: 2,
				os: RequestSanitizer.string(response.headers['os'], true),
				sharePort: Number(!!RequestSanitizer.int(response.headers['share-port'])),
				version: RequestSanitizer.string(response.headers['version'], true)
			});
		}

		cb && cb(null, {body: body, peer: peer});
	});
}

//events
Transport.prototype.onBind = function (scope) {
	modules = scope;

	private.headers = {
		os: modules.system.getOS(),
		version: modules.system.getVersion(),
		port: modules.system.getPort(),
		'share-port': modules.system.getSharePort()
	}
}

Transport.prototype.onBlockchainReady = function () {
	private.loaded = true;
}

Transport.prototype.onUnconfirmedTransaction = function (transaction, broadcast) {
	broadcast && self.broadcast(100, {api: '/transactions', data: {transaction: transaction}, method: "POST"});
}

Transport.prototype.onNewBlock = function (block, broadcast) {
	broadcast && self.broadcast(100, {api: '/blocks', data: {block: block}, method: "POST"})
}

//export
module.exports = Transport;