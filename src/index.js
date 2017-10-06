const express = require("express");
const cors = require("cors");
const path = require("path");
const logger = require('morgan');
const bodyParser = require('body-parser');
const smartAuth = require("./smart-auth");
const reverseProxy = require("./reverse-proxy");
const config = require("./config");
const fhirError = require("./fhir-error");
const fs = require('fs');
const https = require('https');
const sandboxify = require("./sandboxify");
const request = require('request');
const lib = require('./lib');
const privateKey  = fs.readFileSync('./privatekey.pem', 'utf8');
const certificate = fs.readFileSync('./cert.pem', 'utf8');
const credentials = {key: privateKey, cert: certificate};


const handleParseError = function(err, req, res, next) {
    if (err instanceof SyntaxError && err.status === 400) {
        return res.status(400)
            .send( fhirError(`Failed to parse JSON content, error was: ${err.message}`) );
    } else {
        next(err, req, res);
    }
}

const handleXmlRequest = function(err, req, res, next) {
    if (
        req.headers.accept &&req.headers.accept.indexOf("xml") != -1 || 
        req.headers['content-type'] && req.headers['content-type'].indexOf("xml") != -1 ||
        /_format=.*xml/i.test(req.url)
    ) {
        return res.status(400).send( fhirError("XML format is not supported") )
    } else {
        next(err, req, res)
    }
}

const app = express();

app.use(cors());

if (process.env.NODE_ENV == "development") {
    app.use(logger('combined'));
}

//reject xml
app.use(handleXmlRequest);

//provide oidc keys when requested
app.get("/.well-known/openid-configuration/", (req, res) => {
    res.json({"jwks_uri": `${config.baseUrl}/keys`})
});
app.get("/keys", (req, res) => {
    let key = {}
    Object.keys(config.oidcKeypair).forEach(p => {
        if (p != "d") key[p] = config.oidcKeypair[p];
    });
    res.json({"keys":[key]})
});

buildRoutePermutations = (lastSegment) => {
    return [
        "/v/:fhir_release/sb/:sandbox/sim/:sim" + lastSegment, 
        "/v/:fhir_release/sb/:sandbox" + lastSegment, 
        "/v/:fhir_release/sim/:sim" + lastSegment, 
        "/v/:fhir_release" + lastSegment,
    ]
}

// picker
app.get(buildRoutePermutations("/picker"), (req, res) => {
    res.sendFile("picker.html", {root: './static'});
});

// encounter picker
app.get(buildRoutePermutations("/encounter"), (req, res) => {
    res.sendFile("encounter-picker.html", {root: './static'});
});

// login
app.get(buildRoutePermutations("/login"), (req, res) => {
    res.sendFile("login.html", {root: './static'});
});

// authorize
app.get(buildRoutePermutations("/authorize"), (req, res) => {
    res.sendFile("authorize.html", {root: './static'});
});

// authorize
app.get(buildRoutePermutations("/first_encounter"), (req, res) => {
    const apiUrl = sandboxify.buildUrlPath(
        config.baseUrl,
        req.originalUrl.replace("/first_encounter", config.fhirBaseUrl)
    ).split("?")[0];

    request({
        url: apiUrl + "/Encounter",
        qs: {
            _format: "application/json+fhir",
            _count : 1,
            patient: req.query.patient,
            "_sort:desc": "date"
        },
        json: true,
        strictSSL: false
    }, (error, response, body) => {
        
        if (error) {
            return res.status(400).send(error.message);
        }

        if (response.statusCode >= 400) {
            return res.status(response.statusCode).send(response.statusMessage);
        }

        let id = lib.getPath(body, "entry.0.resource.id") || 0;
        let redirectUrl = req.originalUrl.replace(
            "/first_encounter",
            config.authBaseUrl + "/authorize"
        ) + "&encounter=" + encodeURIComponent(id);

        return res.redirect(redirectUrl);
    });
});

// auth request
app.use(buildRoutePermutations(config.authBaseUrl), smartAuth)

// fhir request
app.use(buildRoutePermutations(config.fhirBaseUrl),
    bodyParser.text({ type: "*/*", limit: 1e6 }),
    handleParseError,
    reverseProxy
);

// static request
app.use(express.static("static"));

module.exports = app;

if (!module.parent) {
    https.createServer(credentials, app).listen(config.port);
    console.log(`Proxy server running on https://localhost:${config.port}`);
}
