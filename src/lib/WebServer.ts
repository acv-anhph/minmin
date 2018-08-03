import {HttpServer} from "./base/HttpServer"
import * as express from "express"
import * as _ from "lodash"
import {HttpMethod} from "./common/HttpMethod"
import {buildUrl} from "./common/Route"
import * as compression from 'compression'
import * as helmet from 'helmet'
import * as bodyParser from "body-parser"
import * as cookieParser from "cookie-parser"
import * as  session from 'express-session'
import * as cors from 'cors'

import {Error as RError, IResponse} from "./common/Response"

const SESSION_SECRET = '220183';

class Options {
    nuxt: any;
    useCors: boolean;
}

export class WebServer extends HttpServer {

    public static readonly controllers: any[] = [];

    private express: express.Express;

    private readonly nuxt: any;

    constructor(options?: Options) {
        let application = express();
        super(application);

        this.express = application;
        /* default routes */
        this.express.use(bodyParser.urlencoded({extended: true}));
        this.express.use(bodyParser.json());
        this.express.use(cookieParser());
        this.express.use(session({
            secret: SESSION_SECRET,
            resave: false,
            saveUninitialized: false,
            cookie: {maxAge: 1000 * 60 * 60 * 24}
        }));

        this.express.use(compression({threshold: 0}));
        this.express.use(helmet());

        if (options && options.useCors)
            this.express.use(cors());

        if (options && options.nuxt) {
            const {Nuxt} = require('nuxt');
            this.nuxt = new Nuxt(options.nuxt);
        }
    }

    private static validResponse(result: any): result is IResponse {
        return (result as IResponse).exec !== undefined;
    }

    public start() {
        this.initialize().then(() => {
            super.start();
        });
    }

    private resolveTarget(instance: any, target: any) {
        for (let key in target) {
            if (target.hasOwnProperty(key)) {
                if (Reflect.hasMetadata("custom:inject", target, key)) {
                    let propertyConstructor = Reflect.getMetadata('design:type', target, key);
                    if (Reflect.hasMetadata("custom:service", propertyConstructor.prototype)) {
                        instance[key] = new propertyConstructor;
                        this.resolveTarget(instance[key], propertyConstructor.prototype);
                    }
                }
            }
        }
    }

    private async initialize() {
        if (this.nuxt && this.nuxt.options.dev) {
            const {Builder} = require('nuxt');
            await new Builder(this.nuxt).build();
        }

        let router: any = express.Router();
        let controllers = WebServer.controllers;
        for (const controller of controllers) {
            let target = controller.prototype;

            let routes = Reflect.getOwnMetadata('custom:routes', target);
            let parameters = Reflect.getOwnMetadata('custom:parameters', target);

            let instance = new controller;

            this.resolveTarget(instance, target);

            _.keys(routes)
                .map(key => routes[key])
                .forEach(route => {
                    let url = buildUrl(target, route.name, route.url);
                    this.getLogger().info(HttpMethod[route.method] + ' - ' + url);

                    if (route.middlewares)
                        router[HttpMethod[route.method]](url, route.middlewares, this.createRoute(route, instance, parameters));
                    else
                        router[HttpMethod[route.method]](url, this.createRoute(route, instance, parameters));
                });
        }

        this.express.use(router);

        if (this.nuxt) {
            this.express.use(this.nuxt.render);
        }
    }

    private createRoute(route: any, instance: any, parameters: any) {
        return async (req: express.Request, res: express.Response) => {
            const values: any[] = [];
            if (parameters) {
                const params = parameters[route.name];
                if (params) {
                    for (const param of params) {
                        values[param.index] = param.getValue(req);
                    }
                }
            }

            let result = route.callback.apply(instance, values);
            if (typeof result.then === 'function') {
                try {
                    result = await result;
                } catch (e) {
                    this.getLogger().error(e);
                    result = new RError(500, 'Internal server error.');
                }
            }

            if (WebServer.validResponse(result)) {
                return result.exec(res);
            }
            else {
                throw new Error('Invalid return type.')
            }
        };
    }
}