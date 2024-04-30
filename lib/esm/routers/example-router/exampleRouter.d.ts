import { Elysia } from "elysia";
export declare const exampleRouter: Elysia<"/typedBody", {
    request: {};
    store: {};
    derive: {};
    resolve: {};
}, {
    type: {};
    error: {};
}, {}, {}, {
    "/typedBody/hello": {
        post: {
            body: {
                name: string;
                age: number;
            };
            params: never;
            query: unknown;
            headers: unknown;
            response: {
                200: {
                    name: string;
                    age: number;
                };
            };
        };
    };
    "/typedBody/otherRoute": {
        get: {
            body: unknown;
            params: never;
            query: {
                name: string;
                age: number;
            };
            headers: unknown;
            response: {
                200: {
                    name: string;
                    age: number;
                };
            };
        };
    };
}, false>;
