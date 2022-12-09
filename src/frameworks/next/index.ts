import { execSync } from "child_process";
import { mkdir, copyFile } from "fs/promises";
import { dirname, join } from "path";
import type { NextConfig } from "next";
import type { PrerenderManifest } from "next/dist/build";
import type { MiddlewareManifest } from "next/dist/build/webpack/plugins/middleware-plugin";
import type { PagesManifest } from "next/dist/build/webpack/plugins/pages-manifest-plugin";
import { copy, mkdirp, pathExists } from "fs-extra";
import { pathToFileURL, parse } from "url";
import { existsSync } from "fs";
import { gte } from "semver";
import { IncomingMessage, ServerResponse } from "http";

import {
  BuildResult,
  createServerResponseProxy,
  findDependency,
  FrameworkType,
  NODE_VERSION,
  relativeRequire,
  SupportLevel,
} from "..";
import { promptOnce } from "../../prompt";
import { logger } from "../../logger";
import { FirebaseError } from "../../error";
import { fileExistsSync } from "../../fsutils";
import {
  cleanEscapedChars,
  getNextjsRewritesToUse,
  isHeaderSupportedByFirebase,
  isRedirectSupportedByFirebase,
  isRewriteSupportedByFirebase,
} from "./utils";
import type { Manifest } from "./interfaces";
import { readJSON } from "../utils";
import { warnIfCustomBuildScript } from "../utils";
import type { EmulatorInfo } from "../../emulator/types";

const CLI_COMMAND = join(
  "node_modules",
  ".bin",
  process.platform === "win32" ? "next.cmd" : "next"
);

const DEFAULT_BUILD_SCRIPT = ["next build"];

export const name = "Next.js";
export const support = SupportLevel.Experimental;
export const type = FrameworkType.MetaFramework;

const DEFAULT_NUMBER_OF_REASONS_TO_LIST = 5;

function getNextVersion(cwd: string): string | undefined {
  return findDependency("next", { cwd, depth: 0, omitDev: false })?.version;
}

function getReactVersion(cwd: string): string | undefined {
  return findDependency("react-dom", { cwd, omitDev: false })?.version;
}

/**
 * Returns whether this codebase is a Next.js backend.
 */
export async function discover(dir: string) {
  if (!(await pathExists(join(dir, "package.json")))) return;
  if (!(await pathExists("next.config.js")) && !getNextVersion(dir)) return;
  // TODO don't hardcode public dir
  return { mayWantBackend: true, publicDirectory: join(dir, "public") };
}

/**
 * Build a next.js application.
 */
export async function build(dir: string): Promise<BuildResult> {
  const { default: nextBuild } = relativeRequire(dir, "next/dist/build");

  await warnIfCustomBuildScript(dir, name, DEFAULT_BUILD_SCRIPT);

  const reactVersion = getReactVersion(dir);
  if (reactVersion && gte(reactVersion, "18.0.0")) {
    // This needs to be set for Next build to succeed with React 18
    process.env.__NEXT_REACT_ROOT = "true";
  }

  await nextBuild(dir, null, false, false, true).catch((e) => {
    // Err on the side of displaying this error, since this is likely a bug in
    // the developer's code that we want to display immediately
    console.error(e.message);
    throw e;
  });

  const reasonsForBackend = [];
  const { distDir } = await getConfig(dir);

  const middlewareManifest: MiddlewareManifest = await readJSON(
    join(dir, distDir, "server", "middleware-manifest.json")
  );
  const usingMiddleware = Object.keys(middlewareManifest.middleware).length > 0;
  if (usingMiddleware) {
    reasonsForBackend.push("use of Next middleware");
  }

  const { isNextImageImported } = await readJSON(join(dir, distDir, "export-marker.json"));
  if (isNextImageImported) {
    const imagesManifest = await readJSON(join(dir, distDir, "images-manifest.json"));
    const usingImageOptimization = imagesManifest.images.unoptimized === false;
    if (usingImageOptimization) {
      reasonsForBackend.push(`use of Next Image Optimization`);
    }
  }

  const appPathRoutesManifestPath = join(dir, distDir, "app-path-routes-manifest.json");
  const appPathRoutesManifestJSON = fileExistsSync(appPathRoutesManifestPath)
    ? await readJSON(appPathRoutesManifestPath)
    : {};
  const usingAppDirectory = Object.keys(appPathRoutesManifestJSON).length > 0;
  if (usingAppDirectory) {
    // Let's not get smart here, if they are using the app directory we should
    // opt for spinning up a Cloud Function. The app directory is unstable.
    reasonsForBackend.push("use of Next app directory");
  }

  const prerenderManifest = await readJSON<PrerenderManifest>(
    join(dir, distDir, "prerender-manifest.json")
  );

  const dynamicRoutesWithFallback = Object.entries(prerenderManifest.dynamicRoutes || {}).filter(
    ([, it]) => it.fallback !== false
  );
  if (dynamicRoutesWithFallback.length > 0) {
    for (const [key] of dynamicRoutesWithFallback) {
      reasonsForBackend.push(`use of fallback ${key}`);
    }
  }

  const routesWithRevalidate = Object.entries(prerenderManifest.routes).filter(
    ([, it]) => it.initialRevalidateSeconds
  );
  if (routesWithRevalidate.length > 0) {
    for (const [key] of routesWithRevalidate) {
      reasonsForBackend.push(`use of revalidate ${key}`);
    }
  }

  const pagesManifestJSON = await readJSON<PagesManifest>(
    join(dir, distDir, "server", "pages-manifest.json")
  );
  const prerenderedRoutes = Object.keys(prerenderManifest.routes);
  const dynamicRoutes = Object.keys(prerenderManifest.dynamicRoutes);
  const unrenderedPages = Object.keys(pagesManifestJSON).filter(
    (it) =>
      !(
        ["/_app", "/", "/_error", "/_document", "/404"].includes(it) ||
        prerenderedRoutes.includes(it) ||
        dynamicRoutes.includes(it)
      )
  );
  if (unrenderedPages.length > 0) {
    for (const key of unrenderedPages) {
      reasonsForBackend.push(`non-static route ${key}`);
    }
  }

  const manifest = await readJSON<Manifest>(join(dir, distDir, "routes-manifest.json"));

  const {
    headers: nextJsHeaders = [],
    redirects: nextJsRedirects = [],
    rewrites: nextJsRewrites = [],
  } = manifest;

  const isEveryHeaderSupported = nextJsHeaders.every(isHeaderSupportedByFirebase);
  if (!isEveryHeaderSupported) {
    reasonsForBackend.push(`use of advanced headers`);
  }

  const headers = nextJsHeaders.filter(isHeaderSupportedByFirebase).map(({ source, headers }) => ({
    // clean up unnecessary escaping
    source: cleanEscapedChars(source),
    headers,
  }));

  const isEveryRedirectSupported = nextJsRedirects.every(isRedirectSupportedByFirebase);
  if (!isEveryRedirectSupported) {
    reasonsForBackend.push(`use of advanced redirects`);
  }

  const redirects = nextJsRedirects
    .filter(isRedirectSupportedByFirebase)
    .map(({ source, destination, statusCode: type }) => ({
      // clean up unnecessary escaping
      source: cleanEscapedChars(source),
      destination,
      type,
    }));

  const nextJsRewritesToUse = getNextjsRewritesToUse(nextJsRewrites);

  // rewrites.afterFiles / rewrites.fallback are not supported by firebase.json
  if (
    !Array.isArray(nextJsRewrites) &&
    (nextJsRewrites.afterFiles?.length || nextJsRewrites.fallback?.length)
  ) {
    reasonsForBackend.push(`use of advanced rewrites`);
  } else {
    const isEveryRewriteSupported = nextJsRewritesToUse.every(isRewriteSupportedByFirebase);
    if (!isEveryRewriteSupported) {
      reasonsForBackend.push(`use of advanced rewrites`);
    }
  }

  // Can we change i18n into Firebase settings?
  const rewrites = nextJsRewritesToUse
    .filter(isRewriteSupportedByFirebase)
    .map(({ source, destination }) => ({
      // clean up unnecessary escaping
      source: cleanEscapedChars(source),
      destination,
    }));

  const wantsBackend = reasonsForBackend.length > 0;

  if (wantsBackend) {
    const numberOfReasonsToList = process.env.DEBUG ? Infinity : DEFAULT_NUMBER_OF_REASONS_TO_LIST;
    console.log("Building a Cloud Function to run this application. This is needed due to:");
    for (const reason of reasonsForBackend.slice(0, numberOfReasonsToList)) {
      console.log(` • ${reason}`);
    }
    if (reasonsForBackend.length > numberOfReasonsToList) {
      console.log(
        ` • and ${
          reasonsForBackend.length - numberOfReasonsToList
        } other reasons, use --debug to see more`
      );
    }
    console.log("");
  }

  return { wantsBackend, headers, redirects, rewrites };
}

/** q
 * Utility method used during project initialization.
 */
export async function init(setup: any) {
  const language = await promptOnce({
    type: "list",
    default: "JavaScript",
    message: "What language would you like to use?",
    choices: ["JavaScript", "TypeScript"],
  });
  execSync(
    `npx --yes create-next-app@latest -e hello-world ${setup.hosting.source} --use-npm ${
      language === "TypeScript" ? "--ts" : ""
    }`,
    { stdio: "inherit" }
  );
}

/**
 * Create a directory for SSG content.
 */
export async function ɵcodegenPublicDirectory(sourceDir: string, destDir: string) {
  const { distDir } = await getConfig(sourceDir);

  const publicPath = join(sourceDir, "public");
  await mkdir(join(destDir, "_next", "static"), { recursive: true });
  if (await pathExists(publicPath)) {
    await copy(publicPath, destDir);
  }
  await copy(join(sourceDir, distDir, "static"), join(destDir, "_next", "static"));

  // Copy over the default html files
  for (const file of ["index.html", "404.html", "500.html"]) {
    const pagesPath = join(sourceDir, distDir, "server", "pages", file);
    if (await pathExists(pagesPath)) {
      await copyFile(pagesPath, join(destDir, file));
      continue;
    }
    const appPath = join(sourceDir, distDir, "server", "app", file);
    if (await pathExists(appPath)) {
      await copyFile(appPath, join(destDir, file));
    }
  }

  const middlewareManifest: MiddlewareManifest = await readJSON(
    join(sourceDir, distDir, "server", "middleware-manifest.json")
  );
  const middlewareMatchers = Object.values(middlewareManifest["middleware"])
    .map((it) => it.matchers)
    .flat();

  const [prerenderManifest, routesManifest] = await Promise.all([
    readJSON<PrerenderManifest>(
      join(
        sourceDir,
        distDir,
        "prerender-manifest.json" // TODO: get this from next/constants
      )
    ),
    readJSON<Manifest>(
      join(
        sourceDir,
        distDir,
        "routes-manifest.json" // TODO: get this from next/constants
      )
    ),
  ]);

  const { redirects = [], rewrites = [], headers = [] } = routesManifest;

  const rewritesToUse = getNextjsRewritesToUse(rewrites);
  const rewritesNotSupportedByFirebase = rewritesToUse.filter(
    (rewrite) => !isRewriteSupportedByFirebase(rewrite)
  );
  const rewritesRegexesNotSupportedByFirebase = rewritesNotSupportedByFirebase.map(
    (rewrite) => new RegExp(rewrite.regex)
  );

  const redirectsNotSupportedByFirebase = redirects.filter(
    (redirect) => !isRedirectSupportedByFirebase(redirect)
  );
  const redirectsRegexesNotSupportedByFirebase = redirectsNotSupportedByFirebase.map(
    (redirect) => new RegExp(redirect.regex)
  );

  const headersNotSupportedByFirebase = headers.filter(
    (header) => !isHeaderSupportedByFirebase(header)
  );
  const headersRegexesNotSupportedByFirebase = headersNotSupportedByFirebase.map(
    (header) => new RegExp(header.regex)
  );


  for (const [path, route] of Object.entries(prerenderManifest.routes)) {
    // Skip ISR in the deploy to hosting
    if (route.initialRevalidateSeconds) {
      continue;
    }

    // Skip pages affected by middleware in hosting
    const matchingMiddleware = middlewareMatchers.some((matcher) =>
      new RegExp(matcher.regexp).test(path)
    );
    if (matchingMiddleware) {
      continue;
    }

    const routeMatchUnsupportedRewrite = rewritesRegexesNotSupportedByFirebase.some(
      (rewriteRegex) => rewriteRegex.test(path)
    );
    if (routeMatchUnsupportedRewrite) continue;

    const routeMatchUnsupportedRedirect = redirectsRegexesNotSupportedByFirebase.some(
      (redirectRegex) => redirectRegex.test(path)
    );
    if (routeMatchUnsupportedRedirect) continue;

    const routeMatchUnsupportedHeader = headersRegexesNotSupportedByFirebase.some(
      (headerRegex) => headerRegex.test(path)
    );
    if (routeMatchUnsupportedHeader) continue;

    const isReactServerComponent = route.dataRoute.endsWith(".rsc");
    const contentDist = join(
      sourceDir,
      distDir,
      "server",
      isReactServerComponent ? "app" : "pages"
    );

    const parts = path.split("/").filter((it) => !!it);
    const partsOrIndex = parts.length > 0 ? parts : ["index"];

    const htmlPath = `${join(...partsOrIndex)}.html`;
    await mkdir(join(destDir, dirname(htmlPath)), { recursive: true });
    await copyFile(join(contentDist, htmlPath), join(destDir, htmlPath));

    if (!isReactServerComponent) {
      const dataPath = `${join(...partsOrIndex)}.json`;
      await mkdir(join(destDir, dirname(route.dataRoute)), { recursive: true });
      await copyFile(join(contentDist, dataPath), join(destDir, route.dataRoute));
    }
  }
}

/**
 * Create a directory for SSR content.
 */
export async function ɵcodegenFunctionsDirectory(sourceDir: string, destDir: string) {
  const { distDir } = await getConfig(sourceDir);
  const packageJson = await readJSON(join(sourceDir, "package.json"));
  if (existsSync(join(sourceDir, "next.config.js"))) {
    let esbuild;
    try {
      esbuild = await import("esbuild");
    } catch (e: unknown) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      logger.debug(`Failed to load 'esbuild': ${e}`);
      throw new FirebaseError(
        `Unable to find 'esbuild'. Install it into your local dev dependencies with 'npm i --save-dev esbuild''`
      );
    }
    await esbuild.build({
      bundle: true,
      external: Object.keys(packageJson.dependencies),
      absWorkingDir: sourceDir,
      entryPoints: ["next.config.js"],
      outfile: join(destDir, "next.config.js"),
      target: `node${NODE_VERSION}`,
      platform: "node",
    });
  }
  if (await pathExists(join(sourceDir, "public"))) {
    await mkdir(join(destDir, "public"));
    await copy(join(sourceDir, "public"), join(destDir, "public"));
  }
  await mkdirp(join(destDir, distDir));
  await copy(join(sourceDir, distDir), join(destDir, distDir));
  return { packageJson, frameworksEntry: "next.js" };
}

/**
 * Create a dev server.
 */
export async function getDevModeHandle(dir: string, hostingEmulatorInfo?: EmulatorInfo) {
  const { default: next } = relativeRequire(dir, "next");
  const nextApp = next({
    dev: true,
    dir,
    hostname: hostingEmulatorInfo?.host,
    port: hostingEmulatorInfo?.port,
  });
  const handler = nextApp.getRequestHandler();
  await nextApp.prepare();
  // TODO can we check for middleware and error if we don't have hostingEmulatorInfo
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const parsedUrl = parse(req.url!, true);
    const proxy = createServerResponseProxy(req, res, next);
    handler(req, proxy, parsedUrl);
  };
}

async function getConfig(dir: string): Promise<NextConfig & { distDir: string }> {
  let config: NextConfig = {};
  if (existsSync(join(dir, "next.config.js"))) {
    const version = getNextVersion(dir);
    if (!version) throw new Error("Unable to find the next dep, try NPM installing?");
    if (gte(version, "12.0.0")) {
      const { default: loadConfig } = relativeRequire(dir, "next/dist/server/config");
      const { PHASE_PRODUCTION_BUILD } = relativeRequire(dir, "next/constants");
      config = await loadConfig(PHASE_PRODUCTION_BUILD, dir, null);
    } else {
      try {
        config = await import(pathToFileURL(join(dir, "next.config.js")).toString());
      } catch (e) {
        throw new Error("Unable to load next.config.js.");
      }
    }
  }
  return { distDir: ".next", ...config };
}
