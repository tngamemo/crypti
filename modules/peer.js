var async = require('async');
var util = require('util');
var ip = require('ip');
var Router = require('../helpers/router.js');
var params = require('../helpers/params.js');
var arrayHelper = require('../helpers/array.js');
var extend = require('extend');

//private
var modules, library, self;

//constructor
function Peer(cb, scope) {
	library = scope;
	self = this;

	var router = new Router();

	router.use(function (req, res, next) {
		if (modules) return next();
		res.status(500).send({success: false, error: 'loading'});
	});

	router.get('/', function (req, res) {
		var state = params.int(req.query.state),
			os = params.string(req.query.os),
			version = params.string(req.query.version),
			limit = params.string(req.query.limit),
			shared = params.bool(req.query.shared),
			orderBy = params.string(req.query.orderBy),
			offset = params.int(req.query.offset);

		if (limit < 0 || limit > 100) {
			return res.json({success: false, error: "Max limit is 100"});
		}

		self.filter({
			state: state,
			os: os,
			version: version,
			limit: limit,
			sharePort: shared,
			orderBy: orderBy,
			offset: offset
		}, function (err, peers) {
			if (err) {
				library.logger.error(err.toString());
				return res.json({success: false, error: "Peers not found"});
			}
			res.json({success: true, peers: peers});
		});
	});

	router.get('/get', function (req, res) {
		var ip = params.string(req.query.ip);
		var port = params.int(req.query.port);

		if (!ip) {
			return res.json({success: false, error: "Provide ip in url"});
		}

		if (!port) {
			return res.json({success: false, error: "Provide port in url"});
		}

		self.filter({
			ip: ip,
			port: port
		}, function (err, peers) {
			if (err) {
				return res.json({success: false, error: "Peers not found"});
			}
			res.json({success: true, peer: peers.length ? peers[0] : {}});
		});
	})

	router.use(function (req, res, next) {
		res.status(500).send({success: false, error: 'api not found'});
	});

	library.app.use('/api/peers', router);
	library.app.use(function (err, req, res, next) {
		if (!err) return next();
		library.logger.error('/api/peers', err)
		res.status(500).send({success: false, error: err});
	});

	cb(null, this);
}
//public
Peer.prototype.run = function (scope) {
	modules = scope;
}

Peer.prototype.list = function (limit, cb) {
	limit = limit || 100;
	var params = {limit: limit};

	library.dbLite.query("select ip, port, state, os, sharePort, version from peers where state > 0 and sharePort = 1 ORDER BY RANDOM() LIMIT $limit", params, {'ip' : Number, 'port' : Number, 'state' : Number, 'os' : String, 'sharePort' : Number, 'version' : String}, function (err, res) {
		cb(err, res);
	});
}

Peer.prototype.filter = function (filter, cb) {
	var limit = filter.limit || 100;
	var offset = filter.offset;
	var orderBy = filter.orderBy;

	delete filter.limit;
	delete filter.offset;
	delete filter.orderBy;

	if (orderBy) {
		var sort = orderBy.split(':');
		sortBy = sort[0].replace(/[^\w\s]/gi, '');
		sortBy = "t." + sortBy;
		if (sort.length == 2) {
			sortMethod = sort[1] == 'desc' ? 'desc' : 'asc'
		}
	}

	if (filter.limit > 1000) {
		return cb('Maximum of limit is 1000');
	}

	var where = [];
	var params = {};
	Object.keys(filter).forEach(function (key) {
		where.push(key + " = " + '$' + key);
		params[key] = filter[key];
	});


	params['limit'] = limit;
	offset && (params['offset'] = offset);

	library.dbLite.query("select ip, port, state, os, sharePort, version from peers" + (where.length ? (' where ' + where.join(' and ')) : '') + ' limit $limit' + (offset ? ' offset $offset ' : ''), params, {"ip" : Number, "port" : Number, "state" : String, "os" : String, "sharePort" : Number, "version" : String}, function (err, rows) {
		cb(err, rows);
	});
}

Peer.prototype.state = function (ip, port, state, timeoutSeconds, cb) {
	if (state == 0) {
		var clock = (timeoutSeconds || 1) * 1000;
		clock = Date.now() + clock;
	} else {
		clock = null;
	}

	library.dbLite.query("UPDATE peers SET state = $state, clock = $clock WHERE ip = $ip and port = $port;", {
		state: state,
		clock: clock,
		ip: ip,
		port: port
	}, function (err) {
		err && library.logger.error('Peer#state', err);
		cb && cb();
	});
}

Peer.prototype.parsePeer = function (peer) {
	peer.ip = params.int(peer.ip);
	peer.port = params.int(peer.port);
	peer.state = params.int(peer.state);
	peer.os = params.string(peer.os);
	peer.sharePort = params.bool(peer.sharePort);
	peer.version = params.string(peer.version);
	return peer;
}

Peer.prototype.banManager = function (cb) {
	library.dbLite.query("UPDATE peers SET state = 1, clock = null where (state = 0 and clock - $now < 0)", {now: Date.now()}, function (err, res) {
		cb(err, res);
	});
}

Peer.prototype.update = function (peer, cb) {
	var params = {
		ip: peer.ip,
		port: peer.port,
		os: peer.os || null,
		sharePort: peer.sharePort,
		version: peer.version || null
	}

	async.series([
		function (cb) {
			library.dbLite.query("INSERT OR IGNORE INTO peers (ip, port, state, os, sharePort, version) VALUES ($ip, $port, $state, $os, $sharePort, $version);", extend({}, params, {state: 1}), function (err, res) {
				cb(err, res);
			});
		},
		function (cb) {
			if (peer.state !== undefined) {
				params.state = peer.state;
			}

			library.dbLite.query("UPDATE peers SET os = $os, sharePort = $sharePort, version = $version" + (peer.state !== undefined ? ", state = $state " : "") + " WHERE ip = $ip and port = $port;", params, function (err, res) {
				cb(err, res);
			});
		}
	], function (err) {
		err && library.logger.error('Peer#update', err);
		cb && cb();
	});
}

Peer.prototype.count = function (cb) {
	var params = {};

	library.dbLite.query("select count(rowid) as count from peers", params, {"count": Number}, function (err, rows) {
		if (err) {
			library.logger.error('Peer#count', err);
			return cb(err);
		}

		var res = rows.length && rows[0].count;

		cb(null, res)
	});
}

//export
module.exports = Peer;
