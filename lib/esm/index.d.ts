import { Elysia } from "elysia";
declare const app: Elysia<"", {
    request: {};
    store: {};
    derive: {};
    resolve: {};
}, {
    type: {};
    error: {};
}, {
    body: unknown;
    headers: unknown;
    query: unknown;
    params: unknown;
    cookie: unknown;
    response: unknown;
}, {}, {
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
    "/": {
        get: {
            body: unknown;
            params: never;
            query: unknown;
            headers: unknown;
            response: {
                200: string;
            };
        };
    };
}, false>;
export type ApiType = typeof app;
export {};
