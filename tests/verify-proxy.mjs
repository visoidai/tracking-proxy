import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

const repository = fileURLToPath(new URL("../", import.meta.url));
const origin = "https://app.visoid.com";
const image = "tracking-proxy:verify";

function docker(args) {
    const result = spawnSync("docker", args, {
        encoding: "utf8",
        cwd: repository,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
}

async function waitForProxy(base) {
    const deadline = Date.now() + 10_000;
    while (true) {
        try {
            const response = await fetch(base, {
                signal: AbortSignal.timeout(1000),
            });
            if (response.ok) return;
        } catch (error) {
            if (Date.now() >= deadline) throw error;
        }
        assert.ok(Date.now() < deadline, "nginx did not become ready");
        await new Promise((resolve) => setImmediate(resolve));
    }
}

test("shared Mixpanel and PostHog proxy", async (t) => {
    const upstream = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        response.statusCode = request.url.startsWith("/failure") ? 503 : 200;
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Set-Cookie", "upstream=private");
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.end(
            JSON.stringify({
                path: request.url,
                headers: request.headers,
                body: Buffer.concat(chunks).toString("base64"),
            }),
        );
    });
    await new Promise((resolve) => upstream.listen(0, "0.0.0.0", resolve));
    const address = upstream.address();
    assert.ok(address && typeof address === "object");
    const directory = await mkdtemp(`${repository}.verify-proxy-`);
    const container = `tracking-proxy-${randomUUID()}`;
    let started = false;

    try {
        docker(["build", "--quiet", "-t", image, "."]);
        const hostArgs =
            process.platform === "linux"
                ? ["--add-host=host.docker.internal:host-gateway"]
                : [];
        const hostIp = docker([
            "run",
            "--rm",
            ...hostArgs,
            "--entrypoint",
            "getent",
            image,
            "hosts",
            "host.docker.internal",
        ]).split(/\s+/)[0];
        const mockHost = `http://${hostIp}:${address.port}`;
        const config = (await readFile(`${repository}nginx.conf`, "utf8"))
            .replaceAll("https://api-eu.mixpanel.com", mockHost)
            .replace("https://cdn.mxpnl.com", mockHost)
            .replace(
                "https://$posthog_host$posthog_path",
                `${mockHost}$posthog_path`,
            );
        await writeFile(`${directory}/nginx.conf`, config);
        docker([
            "run",
            "--rm",
            "--entrypoint",
            "nginx",
            "-v",
            `${directory}/nginx.conf:/etc/nginx/nginx.conf:ro`,
            image,
            "-t",
        ]);
        docker([
            "run",
            "--rm",
            "-d",
            "--name",
            container,
            "--entrypoint",
            "nginx",
            "-p",
            "127.0.0.1::80",
            "-v",
            `${directory}/nginx.conf:/etc/nginx/nginx.conf:ro`,
            image,
            "-g",
            "daemon off;",
        ]);
        started = true;
        const base = `http://${docker(["port", container, "80/tcp"]).split("\n")[0]}`;
        await waitForProxy(base);

        await t.test(
            "preserves every existing Mixpanel route, header, cookie and query",
            async () => {
                const routes = [
                    [
                        "/t/example?v=1",
                        "/track/example?v=1",
                        "api-eu.mixpanel.com",
                    ],
                    ["/e/?v=1", "/engage/?v=1", "api-eu.mixpanel.com"],
                    ["/g/?v=1", "/groups/?v=1", "api-eu.mixpanel.com"],
                    ["/r/?v=1", "/record/?v=1", "api-eu.mixpanel.com"],
                    [
                        "/lib.min.js?v=1",
                        "/libs/mixpanel-2-latest.min.js?v=1",
                        new URL(mockHost).host,
                    ],
                    ["/fallback?v=1", "/fallback?v=1", "api-eu.mixpanel.com"],
                ];
                for (const [path, target, host] of routes) {
                    const response = await fetch(`${base}${path}`, {
                        method: "POST",
                        headers: {
                            origin,
                            cookie: "app-session=private",
                            authorization: "Bearer private",
                            "x-forwarded-for": "203.0.113.1",
                        },
                        body: "mixpanel-event",
                    });
                    assert.equal(response.status, 200, path);
                    assert.equal(
                        response.headers.get("set-cookie"),
                        "upstream=private",
                        path,
                    );
                    assert.equal(
                        response.headers.get("access-control-allow-origin"),
                        "*",
                        path,
                    );
                    const received = await response.json();
                    assert.equal(received.path, target, path);
                    assert.equal(received.headers.host, host, path);
                    assert.equal(
                        received.headers.cookie,
                        "app-session=private",
                        path,
                    );
                    assert.equal(
                        received.headers.authorization,
                        "Bearer private",
                        path,
                    );
                    assert.equal(
                        received.headers["x-real-ip"],
                        "203.0.113.1",
                        path,
                    );
                    assert.match(
                        received.headers["x-forwarded-for"],
                        /^203\.0\.113\.1, /,
                        path,
                    );
                    assert.equal(
                        Buffer.from(received.body, "base64").toString(),
                        "mixpanel-event",
                        path,
                    );
                }
            },
        );

        await t.test(
            "separates PostHog events, flags, recordings and assets from Mixpanel",
            async () => {
                for (const [path, host] of [
                    ["/e/?v=1", "eu.i.posthog.com"],
                    ["/flags/?v=2", "eu.i.posthog.com"],
                    ["/s/?v=1", "eu.i.posthog.com"],
                    ["/static/array.js?v=1", "eu-assets.i.posthog.com"],
                    [
                        "/array/phc_test/config.js?v=1",
                        "eu-assets.i.posthog.com",
                    ],
                    ["/e/encoded%2Fvalue?value=a%26b%3Dc", "eu.i.posthog.com"],
                ]) {
                    const response = await fetch(`${base}/relay${path}`);
                    assert.equal(response.status, 200, path);
                    const received = await response.json();
                    assert.equal(received.path, path, path);
                    assert.equal(received.headers.host, host, path);
                }
            },
        );

        await t.test(
            "strips credentials only for PostHog while preserving compressed recordings and IP",
            async () => {
                const body = gzipSync(randomBytes(2 * 1024 * 1024));
                const response = await fetch(`${base}/relay/s/?v=1`, {
                    method: "POST",
                    headers: {
                        origin,
                        "content-type": "application/octet-stream",
                        "content-encoding": "gzip",
                        cookie: "app-session=private",
                        authorization: "Bearer private",
                        "x-forwarded-for": "203.0.113.1",
                        "user-agent": "proxy-verification",
                    },
                    body,
                });
                assert.equal(response.status, 200);
                assert.equal(response.headers.get("set-cookie"), null);
                assert.equal(
                    response.headers.get("access-control-allow-origin"),
                    origin,
                );
                const received = await response.json();
                assert.equal(received.headers.cookie, undefined);
                assert.equal(received.headers.authorization, undefined);
                assert.equal(received.headers["content-encoding"], "gzip");
                assert.equal(
                    received.headers["content-type"],
                    "application/octet-stream",
                );
                assert.equal(
                    received.headers["x-forwarded-for"],
                    "203.0.113.1",
                );
                assert.equal(
                    received.headers["user-agent"],
                    "proxy-verification",
                );
                assert.deepEqual(Buffer.from(received.body, "base64"), body);
                const mixpanel = await fetch(`${base}/r/`, {
                    method: "POST",
                    body,
                });
                assert.equal(
                    mixpanel.status,
                    413,
                    "Mixpanel retains its existing 1 MB request limit",
                );
            },
        );

        await t.test(
            "handles PostHog preflight for app and preview origins without accepting other origins",
            async () => {
                for (const allowed of [
                    origin,
                    "https://codex-example--visoid.netlify.app",
                ]) {
                    const response = await fetch(`${base}/relay/e/`, {
                        method: "OPTIONS",
                        headers: {
                            origin: allowed,
                            "access-control-request-headers":
                                "content-type,content-encoding",
                        },
                    });
                    assert.equal(response.status, 204);
                    assert.equal(
                        response.headers.get("access-control-allow-origin"),
                        allowed,
                    );
                    assert.equal(
                        response.headers.get("access-control-allow-headers"),
                        "content-type,content-encoding",
                    );
                }
                for (const blocked of [
                    "https://other.example",
                    "https://appxvisoid.com",
                    "https://app.visoid.com.evil.example",
                ]) {
                    const response = await fetch(`${base}/relay/e/`, {
                        method: "OPTIONS",
                        headers: { origin: blocked },
                    });
                    assert.equal(
                        response.headers.get("access-control-allow-origin"),
                        null,
                    );
                }
                const mixpanel = await fetch(`${base}/e/`, {
                    method: "OPTIONS",
                    headers: { origin },
                });
                assert.equal(mixpanel.status, 200);
                assert.equal(
                    mixpanel.headers.get("access-control-allow-origin"),
                    "*",
                );
            },
        );

        await t.test(
            "preserves upstream failures and restricts only PostHog HTTP methods",
            async () => {
                const failure = await fetch(`${base}/relay/failure`, {
                    headers: { origin },
                });
                assert.equal(failure.status, 503);
                assert.equal(
                    failure.headers.get("access-control-allow-origin"),
                    origin,
                );
                assert.equal(
                    (await fetch(`${base}/relay/e/`, { method: "DELETE" }))
                        .status,
                    405,
                );
                assert.equal(
                    (await fetch(`${base}/e/`, { method: "DELETE" })).status,
                    200,
                );
            },
        );
    } finally {
        if (started) docker(["stop", "-t", "1", container]);
        upstream.closeAllConnections();
        await new Promise((resolve) => upstream.close(resolve));
        await rm(directory, { recursive: true, force: true });
    }
});
