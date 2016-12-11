/*=========================== dependency  		===========================*/
var googleMaps		= require('@google/maps')
var async			= require('async');
var binarySearch	= require("binary-search");
var bodyParser 		= require('body-parser');
var ejs				= require('ejs');
var express 		= require("express");
var mongoose		= require('mongoose');
var request 		= require('request');
var naturalCompare 	= require('string-natural-compare');


/*=========================== mongodb variables	===========================*/
mongoose.Promise = global.Promise;
var	Schema = mongoose.Schema;
var uri = 'mongodb://root:root@ds127928.mlab.com:27928/my_app_db';
var db = mongoose.connect(uri);
mongoose.connection.on('error', handler);


/*=========================== mongodb models	===========================*/
var termSchema = Schema({
	_id				: String,	// The text content of the term autocomplete suggestion.
});

var businessSchema = Schema({
	_id				: String,	// Yelp id of the business. 
	name			: String,	// Name of the business.
	image_url		: String,	// URL of photo for this business.
	is_closed		: Boolean,	// Whether business has been (permanently) closed
	url				: String,	// URL for business page on Yelp.
	price			: String,	// Price level of the business. Value is one of $, $$, $$$ and $$$$.
	phone			: String,	// Phone number of the business.
	rating			: Number,	// Rating for this business (value ranges from 1, 1.5, ... 4.5, 5).
	review_count	: Number,	// Number of reviews for this business.
	categories		: [{type: String, ref: 'Category'}],

	coordinates		: String,	// This field is not used during actual search. Only for display
	location		: String,	// (same as above)
});

var categorySchema = Schema({
	_id				: String,	// Alias of a category, for searching
	title			: String	// Title of a category for display purpose.
});

var coordinateSchema = Schema({
	_id				: String,	// The name of the location (formatted_address)
	latitude		: Number,	// The latitude of the search location
	longitude		: Number,	// The longitude of the search location
});

var Term 		= mongoose.model('Term', termSchema);
var Business 	= mongoose.model('Business', businessSchema);
var Category	= mongoose.model('Category', categorySchema);
var Coordinate	= mongoose.model('Coordinate', coordinateSchema);

var models		= {
	'terms'		: Term,
	'businesses': Business,
	'categories': Category
};


/*=========================== yelp				===========================*/
// Yelp's Fusion API
var url_autocomplete 	= 'https://api.yelp.com/v3/autocomplete' 						// Get autocomplete suggestions based on user's input
var url_deliver 		= 'https://api.yelp.com/v3/transactions/delivery/search'		// Search for businesses supporting delivery
var url_biz_search		= 'https://api.yelp.com/v3/businesses/search'					// Search for businesses with a keyword
var url_biz_detail 		= 'https://api.yelp.com/v3/businesses/'							// Get business details

// Get business reviews
function getUrlBizReviews(biz) {
	return url_biz_detail + biz + '/reviews'
}


/*=========================== express/route/ejs	===========================*/
var app = express();
var router = express.Router();
var path = __dirname + '/views/';

app.set('view engine', 'ejs');

router.use(function (req, res, next) {
	console.log("/" + req.method);
	next();
});

router.get("/", function(req, res) {
	res.render('index', {myCoord:myCoord, isHome:true, isLocation:false, output:null});
});

router.get("/location", function(req, res) {
	res.render('index', {myCoord:myCoord, isHome:false, isLocation:true, output:null});
});

router.get("/results", function(req, res) {
	res.render('index', {myCoord:myCoord, isHome:false, isLocation:false, output:resultArr});
});

router.get("/details", function(req, res) {
	res.render('index', {myCoord:myCoord, isHome:false, isLocation:false, output:detailObj});
});

app.use("/",router);
app.use(bodyParser.json()); 						// support json encoded bodies
app.use(bodyParser.urlencoded({extended: true})); 	// support encoded bodies


// POST method route
app.post("/location", function (req, res) {
	if (isProcessing) {
		res.redirect("/location");
		return;
	}
	isProcessing = true;

	var params = req.body;
	console.log(params);

	var keys = params == null ? [] : Object.keys(params);
	var address = "";
	for (var i = 0; i < keys.length; i++) {
		var key = keys[i];
		var val = req.body[key];
		if (val != null && val.length > 0) {
			if (address.length > 0) {
				address += ", ";
			}
			address += val.toLowerCase();
		}
	}
	if (showDebugLog) console.log(address);

	function callback(err) {
		if (err) return handler (err);
		if (showDebugLog) console.log("Process complete (location)");
		isProcessing = false;
		res.redirect("/");
	}

	// Geocode an address.
	googleMapsClient.geocode({
		address: address
	}, function(err, response) {
		if (err) return handler(err);
		var results = response.json.results;

		forEachOf(results, function(item, key, callback) {
			if (showDebugLog) console.log(item);
			var address = item['formatted_address'].toLowerCase();
			var geometry = item['geometry'];
			var location = (geometry == null ? null : geometry.location);

			var myModel = new Coordinate({_id:address});
			if (location != null) {
				myModel.latitude = location.lat;
				myModel.longitude = location.lng;
			}
			saveOrUpdate(Coordinate, [myModel]);
		}, callback());

		// redirect to home page after setting new location/coordinates
		// use closest guess (1st item in array) as new location
		var item = results[0];
		var address = item['formatted_address'].toLowerCase();
		var geometry = item['geometry'];
		var location = (geometry == null ? null : geometry.location);
		if (myCoord._id != address && location != null) {
			myCoord._id = address;
			myCoord.latitude = location.lat;
			myCoord.longitude = location.lng;
			console.log("new location:" + address + "(" + myCoord.latitude + ", " + myCoord.longitude + ")");
			// clear results from previous search
			resultArr = null;
			detailObj = null;
		}
		res.redirect("/");
	});
})


app.post("/", function (req, res) {
	if (isProcessing) {
		res.redirect("/");
		return;
	}
	isProcessing = true;

	var params = req.body;
	console.log(params);

	var keys = params == null ? [] : Object.keys(params);
	var text = params == null ? "" : params['text'];

	for (var i = 0; i < keys.length; i++) {
		var key = keys[i];
		if (showDebugLog) console.log(key + ": " + options.qs[key] + " -> "+ params[key]);
		options.qs[key] = params[key];
	}
	// max results per request returned by yelp
	if (options.qs['limit'] != null && options.qs['limit'] > 50) {
		options.qs['limit'] = 50;
	}

	function process(obj) {
		if (showDebugLog) console.log("process");
		if (showDebugLog) console.log(options.url);
		resultArr = obj.businesses;
		res.redirect("/results");
		isProcessing = false;
	}

	function search(err) {
		if (showDebugLog) console.log("search");
		if (showDebugLog) console.log(options.url);
		if (err) return handler(err);

		Term.findOne({_id:text}, function(err, model) {
			options.url = url_biz_search;
			if (model != null) {
				options.qs['term'] = model._id;
			}
			options.qs['latitude'] = myCoord.latitude;
			options.qs['longitude'] = myCoord.longitude;
			sendRequest(process, function(err) {if (err) return handler(err)});
		});
	};

	if (text != null && text.length > 0 && text.trim()) {
		var text = text.toLowerCase();

		Term.findOne({_id:text}, function(err, model) {
			if (err) return handler(err);
			if (model == null) {
				if (showDebugLog) console.log("term:\"" + text + "\" not found");
				// not found in DB -> get autocomplete from yelp
				options.url = url_autocomplete;
				options.qs['text'] = text;
				options.qs['latitude'] = myCoord.latitude;
				options.qs['longitude'] = myCoord.longitude;
				sendRequest(null, search());
			} else {
				console.log("term:\"" + text + "\" is found in cache");
				search(null);
			}
		});
	} else {
		search(null);
	}
})


app.post("/results", function (req, res) {
	if (isProcessing) {
		res.redirect("/results");
		return;
	}
	isProcessing = true;

	var params = req.body;
	console.log(params);

	var keys = params == null ? [] : Object.keys(params);
	var id = params == null ? null : params['id'];

	if (id != null) {
		// this business should be already saved in DB during previous search
		// for this small project, the extra data provided by Yelp's business detail API will not be used
		Business.findOne({_id:id}, function(err, model) {
			if (err) return handler(err);
			if (model == null) return handler("DB error");

			detailObj = model;
			res.redirect("/details");
			isProcessing = false;
		});
	} else if (resultArr != null) {
		for (var i = 0; i < keys.length; i++) {
			var keyString = keys[i];
			var val = params[keyString];
			if (val == null || val.length == 0) {
				continue;
			}
			console.log(keyString + ": " + val);

			// take xxx from sort_by_xxx as key
			var keyArr = keyString.split("_");
			var key = keyArr[keyArr.length - 1];
			var order = val == 'asc' ? 1 : -1;
			resultArr.sort(function(a, b) {
				var o1 = a[key];
				var o2 = b[key];
				if ((o1 == null || o1.length == 0) && o2 != null && o2.length > 0) return 1;
				if ((o2 == null || o2.length == 0) && o1 != null && o1.length > 0) return -1;
				return order * naturalCompare(o1, o2);
			});
		}
		res.redirect("/results");
		isProcessing = false;
	} else {
		res.redirect("/");
		isProcessing = false;
	}
});


app.use(function (err, req, res, next) {
	console.error(err.stack)
	res.status(500).send(err);
})

app.listen(3000, function() {
	console.log("Live at Port 3000");
});



/*=========================== google map client	===========================*/
var googleMapsClient = googleMaps.createClient({
	key: 'AIzaSyCf1tgGOHyiAukJKaepOFEZJgsit8TauLw'
});


/*=========================== local variables	===========================*/

var forEachOf = async.forEachOf;

var showDebugLog = false;

// server side variable to avoid double post
var isProcessing = false;

// cache for search results
// this project is not designed for multiple users accessing at the same time; can be scaled up if necessary (e.g store in DB)
var resultArr = null;
var detailObj = null;

// for latitude/longitude; toFixed(precision)
var precision = 6;

// Use Singapore coordinates for default
var singapore = new Coordinate({
	_id			:'singapore',
	latitude	:1.352083,
	longitude	:103.819836,
});
var myCoord = singapore;
saveOrUpdate(Coordinate, [singapore]);

// Set the headers
var headers = {
    'User-Agent':       'Super Agent/0.0.1',
    'Content-Type':     'application/x-www-form-urlencoded'
}

// Configure the request
var options = {
    url: url_autocomplete,
    method: 'GET',
    headers: headers,
	auth: {
		'bearer':		'je-ihQsK4SQ6SUVMAB0F1EjWTsGeB8wmo63pNygIXfW4P1LL4g-N97isxsBA-aDI5sKaFmfY0BiVw2vzyVO3oudIWIpYp8J-IeWYR8ZyKd7JNd-5vrpSsAGjvGVLWHYx'
	},
    qs: {
		'text':			"del",
		'latitude':		myCoord.latitude,
		'longitude':	myCoord.longitude,
	}
}

// this function is meant for retrieving data from Yelp API
// to be used together with options object
function sendRequest(process, callback) {
	// Start the request
	request(options, function (error, response, body) {
		//Check for error
		if(error){
			return handler(error);
		}

		//Check for right status code
		if(response.statusCode !== 200){
			console.log('Invalid Status Code:', response.statusCode);
		}

		// Parse json object
		var json = JSON.parse(body);
		if (process != null) {
			if (showDebugLog) console.log("process json");
			process(json);
		}

		// async cache
		forEachOf(json, function(jsonArr, key, callback) {
			var model		= models[key];
			var arr			= [];
			var categoryArr = [];	// for Business ref only

			if (showDebugLog) console.log("json length:" + Object.keys(json).length + " biz length:" + json['businesses'].length);

			if (model == null) {
				if (showDebugLog) console.log("no model found for key:" + key);
			} else {
				if (showDebugLog) console.log("model found (" + model.modelName + ") for key:" + key);
				if (showDebugLog) console.log("target array length: " + jsonArr.length);

				for (var i = 0; i < jsonArr.length; i++) {
					var current = jsonArr[i];
					var myModel = new model();
					var keyName = '_id';
					switch (model) {
						case Term:
							myModel.set(keyName, current.text);
							break;
						case Business:
							myModel.set(keyName, current.id);
							break;
						case Category:
							myModel.set(keyName, current.alias);
							break;
					}
					myModel.set(keyName, myModel._id.toLowerCase());

					if (showDebugLog) console.log("i: " + i + " max:" + jsonArr.length + "; _id: " + myModel.get(keyName));

					// overwrite paths with values from JSON
					var paths = Object.keys(myModel.schema.paths);
					for (var j = 0; j < paths.length; j++) {
						var path = paths[j];

						if (showDebugLog) console.log("j: " + j + " max:" + paths.length + "; " + path + ": " + current[path]);
						if (j > paths.length || i > jsonArr.length) return;

						if (current[path] != null) {
							if (model == Business && path == 'categories') {
								if (myModel.get(path) == null) {
									myModel.set(path, []);
								}
								var tmpArr = myModel.get(path);
								for (var k = 0; k < current[path].length; k++) {
									var tmpCategory = current[path][k];
									var tmpAlias = tmpCategory['alias'];
									var tmpTitle = tmpCategory['title'];
									tmpArr.push(tmpAlias);
									categoryArr.push(new Category({_id:tmpAlias, title:tmpTitle}));
								}
								myModel.set(path, tmpArr);
							} else if (model == Business && path == 'coordinates') {
								var val = current[path];
								var tmpString = val['latitude'].toFixed(precision) + "," + val['longitude'].toFixed(precision);
								myModel.set(path, tmpString);
							} else if (model == Business && path == 'location') {
								var tmpString = "";
								var keys = Object.keys(current[path]);
								keys.sort(function(a, b) {return naturalCompare(a, b)});
								for (var k = 0; k < keys.length; k++) {
									var tmpKey = keys[k];
									var val = current[path][tmpKey];
									if (val != null && val.length > 0) {
										// check duplicates
										var isDuplicate = false;
										for (var l = 0; l < k; l++) {
											if (current[path][keys[l]] == val) {
												isDuplicate = true;
												break;
											}
										}
										if (isDuplicate) {
											continue;
										}
										if (tmpString.length > 0) {
											tmpString += ";";
										}
										tmpString += tmpKey + ":" + val;
									}
								}
								myModel.set(path, tmpString);
							} else {
								myModel.set(path, current[path]);
							}
						}
					}

					arr.push(myModel);
					if (showDebugLog) console.log(myModel.modelName + " ready. arr size: " + arr.length);
				}
				if (showDebugLog) console.log(myModel.modelName + " array ready. size: " + arr.length);
				if (showDebugLog) console.log(Category.modelName + " array ready. size: " + categoryArr.length);
				saveOrUpdate(model, arr);
				saveOrUpdate(Category, categoryArr);
			}
		}, callback);
	})
};

// async save or update
function saveOrUpdate(model, arr) {
	if (arr == null || arr.length == 0) {
		return;
	}

	// remove duplicates
	var tmpObj = {};
	var uniqueArr = [];
	for (var i = 0; i < arr.length; i++) {
		var obj = arr[i];
		var key = obj._id;
		tmpObj[key] = obj;
	}
	var keys = Object.keys(tmpObj);
	for (var i = 0; i < keys.length; i++) {
		var key = keys[i];
		var obj = tmpObj[key];
		uniqueArr.push(obj);
	}

	if (showDebugLog) {				
		var modelName = model.modelName;
		if (modelName.length <= 4) {
			modelName += "\t";
		}
		var lengthMsg = " \tlength: " + arr.length + ", " + keys.length + ", " + uniqueArr.length;
		console.log("saving " + modelName + " \tinput size:" + uniqueArr.length + lengthMsg);
	}

	model.find({}, function(err, modelArr) {
		if (err) return handler(err);

		// sort models in order to do binary search
		modelArr.sort(function(a, b) {return naturalCompare(a._id, b._id)});
		if (showDebugLog) console.log("sorted " + model.modelName + " array. size: " + modelArr.length);

		var matchedCount = 0;
		for (var i = 0; i < uniqueArr.length; i++) {
			var myModel = uniqueArr[i];
			var pos = binarySearch(modelArr, myModel, function(a, b) {return naturalCompare(a._id, b._id)});
			var matched = null;
			if (pos >= 0 && pos < modelArr.length) {
				matched = modelArr[pos];
			}
			if (matched != null) {
				if (showDebugLog) console.log("matched at pos " + pos);
				matchedCount ++;
				var paths = Object.keys(myModel.schema.paths);
				for (var j = 0; j < paths.length; j++) {
					var path = paths[j];
					matched.set(path, myModel.get(path));
				}
				myModel = matched;
			}
			myModel.save(function (err) {
				if (err) return handler(err);
				if (showDebugLog) console.log(model.modelName + " saved");
			});
		}
	});
}

function handler(err) {
	console.error(err.stack);
	if (isProcessing) {
		isProcessing = false;
		console.log("Process failed");
	}
}