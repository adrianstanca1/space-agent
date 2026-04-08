import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  listProjectScanRoots,
  resolveProjectAbsolutePath,
  resolveProjectPathFromAbsolute
} from "../customware/layout.js";
import { globToRegExp, normalizePathSegment } from "../utils/app_files.js";
import { parseSimpleYaml } from "../../../app/L0/_all/mod/_core/framework/js/yaml-lite.js";

const REFRESH_DEBOUNCE_MS = 75;
const RECONCILE_INTERVAL_MS = 1_000;
const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));

export class WatchdogHandler {
  constructor(options = {}) {
    this.name = String(options.name || "");
    this.patterns = Array.isArray(options.patterns) ? [...options.patterns] : [];
    this.projectRoot = String(options.projectRoot || "");
    this.runtimeParams = options.runtimeParams || null;
    this.state = this.createInitialState();
  }

  createInitialState() {
    return null;
  }

  getState() {
    return this.state;
  }

  async onStart(_context) {}

  async onChanges(_context) {}
}

function tryReadTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function tryStat(targetPath) {
  try {
    return fs.statSync(targetPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function stripTrailingSlash(value) {
  return String(value || "").endsWith("/") ? String(value).slice(0, -1) : String(value || "");
}

function normalizeDirectorySuffix(projectPath, isDirectory = false) {
  if (!projectPath) {
    return "";
  }

  const normalized = stripTrailingSlash(projectPath);
  return isDirectory ? `${normalized}/` : normalized;
}

export function normalizeProjectPath(input, options = {}) {
  const normalized = normalizePathSegment(input);

  if (!normalized) {
    return "";
  }

  const isDirectory = Boolean(options.isDirectory) || normalized.endsWith("/");
  const normalizedPath = `/${stripTrailingSlash(normalized)}`;

  return normalizeDirectorySuffix(normalizedPath, isDirectory);
}

export function toProjectPath(projectRoot, absolutePath, options = {}) {
  return resolveProjectPathFromAbsolute(projectRoot, absolutePath, options);
}

function getProjectPathLookupCandidates(projectPath) {
  const normalized = normalizeProjectPath(projectPath);

  if (!normalized) {
    return [];
  }

  const basePath = stripTrailingSlash(normalized);
  return normalized.endsWith("/") ? [normalized, basePath] : [normalized, `${basePath}/`];
}

function getStatsSignature(stats) {
  if (!stats) {
    return "";
  }

  return `${Math.trunc(stats.mtimeMs)}:${stats.size}`;
}

function loadWatchdogConfig(configPath) {
  const sourceText = tryReadTextFile(configPath);

  if (sourceText === null) {
    throw new Error(`Watchdog config not found: ${configPath}`);
  }

  const parsed = parseSimpleYaml(sourceText);
  const handlerConfigs = [];
  const uniquePatterns = [];
  const seenPatterns = new Set();

  for (const [name, rawValue] of Object.entries(parsed)) {
    const handlerName = String(name || "").trim();

    if (!handlerName) {
      continue;
    }

    const rawPatterns = Array.isArray(rawValue) ? rawValue : rawValue ? [rawValue] : [];
    const patterns = rawPatterns
      .filter((value) => typeof value === "string")
      .map((value) => normalizeProjectPath(value))
      .filter(Boolean);

    if (patterns.length === 0) {
      throw new Error(
        `Watchdog config must define at least one path for handler "${handlerName}": ${configPath}`
      );
    }

    handlerConfigs.push({
      name: handlerName,
      patterns
    });

    patterns.forEach((pattern) => {
      if (seenPatterns.has(pattern)) {
        return;
      }

      seenPatterns.add(pattern);
      uniquePatterns.push(pattern);
    });
  }

  if (handlerConfigs.length === 0) {
    throw new Error(`Watchdog config must define at least one handler: ${configPath}`);
  }

  if (!handlerConfigs.some((handlerConfig) => handlerConfig.name === "path_index")) {
    throw new Error(`Watchdog config must define a "path_index" handler: ${configPath}`);
  }

  return {
    configPath,
    handlers: handlerConfigs,
    patterns: uniquePatterns
  };
}

function getFixedPatternPrefix(pattern) {
  const relativePattern = normalizePathSegment(pattern);
  const segments = relativePattern ? relativePattern.split("/") : [];
  const prefixSegments = [];

  for (const segment of segments) {
    if (/[*?[\]{}]/u.test(segment)) {
      break;
    }

    prefixSegments.push(segment);
  }

  return prefixSegments.join("/");
}

function getExistingWatchBase(absolutePath) {
  let currentPath = path.resolve(String(absolutePath || ""));

  while (true) {
    const stats = tryStat(currentPath);
    if (stats && stats.isDirectory()) {
      return currentPath;
    }

    if (currentPath === path.dirname(currentPath)) {
      return currentPath;
    }

    currentPath = path.dirname(currentPath);
  }
}

function walkDirectories(startDir, output) {
  const stats = tryStat(startDir);
  if (!stats || !stats.isDirectory()) {
    return;
  }

  output.add(startDir);

  const entries = fs.readdirSync(startDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    walkDirectories(path.join(startDir, entry.name), output);
  }
}

function walkFiles(startDir, callback) {
  const stats = tryStat(startDir);
  if (!stats || !stats.isDirectory()) {
    return;
  }

  const entries = fs.readdirSync(startDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(startDir, entry.name);

    if (entry.isDirectory()) {
      walkFiles(fullPath, callback);
      continue;
    }

    if (entry.isFile()) {
      callback(fullPath);
    }
  }
}

function createCompiledPatterns(patterns) {
  return patterns.map((pattern) => {
    const normalized = normalizePathSegment(pattern);

    return {
      pattern: normalizeProjectPath(pattern),
      matcher: globToRegExp(normalized)
    };
  });
}

function matchesCompiledPatterns(compiledPatterns, projectPath) {
  const normalized = normalizePathSegment(projectPath);

  if (!normalized) {
    return false;
  }

  const candidates = normalized.endsWith("/") ? [normalized, normalized.slice(0, -1)] : [normalized];

  return compiledPatterns.some(({ matcher }) => candidates.some((candidate) => candidate && matcher.test(candidate)));
}

function toAbsolutePath(projectRoot, projectPath, runtimeParams) {
  return resolveProjectAbsolutePath(projectRoot, projectPath, runtimeParams);
}

function inferDeletedProjectPath(projectRoot, absolutePath, currentPathIndex, runtimeParams) {
  const fileProjectPath = toProjectPath(projectRoot, absolutePath, { runtimeParams });
  const directoryProjectPath = toProjectPath(projectRoot, absolutePath, {
    isDirectory: true,
    runtimeParams
  });

  if (directoryProjectPath && currentPathIndex[directoryProjectPath]) {
    return {
      isDirectory: true,
      projectPath: directoryProjectPath
    };
  }

  return {
    isDirectory: false,
    projectPath: fileProjectPath
  };
}

async function loadConfiguredHandlers(handlerDir, handlerConfigs, projectRoot, runtimeParams) {
  const configuredHandlers = [];

  for (const handlerConfig of handlerConfigs) {
    const modulePath = path.join(handlerDir, `${handlerConfig.name}.js`);
    let handlerModule;

    try {
      handlerModule = await import(pathToFileURL(modulePath).href);
    } catch (error) {
      if (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND") {
        throw new Error(`Watchdog handler "${handlerConfig.name}" was not found at ${modulePath}.`);
      }

      throw error;
    }

    const HandlerClass = handlerModule.default;

    if (
      typeof HandlerClass !== "function" ||
      !(HandlerClass === WatchdogHandler || HandlerClass.prototype instanceof WatchdogHandler)
    ) {
      throw new Error(
        `Watchdog handler "${handlerConfig.name}" must export a default class extending WatchdogHandler.`
      );
    }

    configuredHandlers.push({
      compiledPatterns: createCompiledPatterns(handlerConfig.patterns),
      instance: new HandlerClass({
        name: handlerConfig.name,
        patterns: [...handlerConfig.patterns],
        projectRoot,
        runtimeParams
      }),
      name: handlerConfig.name,
      patterns: [...handlerConfig.patterns]
    });
  }

  return configuredHandlers;
}

export function createWatchdog(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || path.join(CURRENT_DIR, "..", "..", ".."));
  const runtimeParams = options.runtimeParams || null;
  const configPath = path.resolve(options.configPath || path.join(CURRENT_DIR, "config.yaml"));
  const handlerDir = path.resolve(options.handlerDir || path.join(CURRENT_DIR, "handlers"));
  const reconcileIntervalMs = Number(options.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS);
  const watchConfig = options.watchConfig !== false;
  let compiledPatterns = [];
  let configuredHandlers = [];
  let currentPathIndex = Object.create(null);
  let lastConfigSignature = "";
  let started = false;
  let refreshInProgress = false;
  let pendingRefresh = false;
  let refreshTimer = null;
  let pathSyncInProgress = false;
  let pathSyncTimer = null;
  let reconcileTimer = null;
  let configWatcher = null;
  const pendingChangedPaths = new Set();
  const directoryWatchers = new Map();
  const handlerStates = new Map();

  function removeCurrentEntries(projectPath) {
    const normalizedBase = stripTrailingSlash(normalizeProjectPath(projectPath));

    if (!normalizedBase) {
      return false;
    }

    let changed = false;

    for (const existingPath of Object.keys(currentPathIndex)) {
      const existingBase = stripTrailingSlash(existingPath);

      if (existingBase === normalizedBase || existingBase.startsWith(`${normalizedBase}/`)) {
        delete currentPathIndex[existingPath];
        changed = true;
      }
    }

    return changed;
  }

  function upsertCurrentEntry(absolutePath, entryOptions = {}) {
    const projectPath = toProjectPath(projectRoot, absolutePath, {
      ...entryOptions,
      runtimeParams
    });

    if (!projectPath) {
      return false;
    }

    if (!matchesCompiledPatterns(compiledPatterns, projectPath)) {
      return removeCurrentEntries(projectPath);
    }

    if (currentPathIndex[projectPath] === true) {
      return false;
    }

    currentPathIndex[projectPath] = true;
    return true;
  }

  function rebuildCurrentPathIndex() {
    const nextPathIndex = Object.create(null);
    const scanRoots = new Set();

    for (const { pattern } of compiledPatterns) {
      const fixedPrefix = getFixedPatternPrefix(pattern);

      for (const scanRoot of listProjectScanRoots(projectRoot, fixedPrefix, runtimeParams)) {
        scanRoots.add(scanRoot);
      }
    }

    for (const scanRoot of scanRoots) {
      const directories = new Set();
      walkDirectories(scanRoot, directories);

      directories.forEach((directoryPath) => {
        const projectPath = toProjectPath(projectRoot, directoryPath, {
          isDirectory: true,
          runtimeParams
        });

        if (projectPath && matchesCompiledPatterns(compiledPatterns, projectPath)) {
          nextPathIndex[projectPath] = true;
        }
      });

      walkFiles(scanRoot, (filePath) => {
        const projectPath = toProjectPath(projectRoot, filePath, {
          runtimeParams
        });

        if (projectPath && matchesCompiledPatterns(compiledPatterns, projectPath)) {
          nextPathIndex[projectPath] = true;
        }
      });
    }

    currentPathIndex = nextPathIndex;
  }

  function createCurrentChangeFromProjectPath(projectPath) {
    return {
      absolutePath: toAbsolutePath(projectRoot, projectPath, runtimeParams),
      exists: true,
      isDirectory: projectPath.endsWith("/"),
      kind: "upsert",
      projectPath
    };
  }

  function createChangeEvent(absolutePath) {
    const stats = tryStat(absolutePath);

    if (stats && stats.isDirectory()) {
      return {
        absolutePath,
        exists: true,
        isDirectory: true,
        kind: "upsert",
        projectPath: toProjectPath(projectRoot, absolutePath, {
          isDirectory: true,
          runtimeParams
        })
      };
    }

    if (stats) {
      return {
        absolutePath,
        exists: true,
        isDirectory: false,
        kind: "upsert",
        projectPath: toProjectPath(projectRoot, absolutePath, {
          runtimeParams
        })
      };
    }

    const deletedPath = inferDeletedProjectPath(
      projectRoot,
      absolutePath,
      currentPathIndex,
      runtimeParams
    );

    return {
      absolutePath,
      exists: false,
      isDirectory: deletedPath.isDirectory,
      kind: "delete",
      projectPath: deletedPath.projectPath
    };
  }

  function getCurrentPaths() {
    return Object.keys(currentPathIndex).sort((left, right) => left.localeCompare(right));
  }

  function createHandlerContext(configuredHandler, matchingChanges = []) {
    return {
      changes: matchingChanges.map((change) => ({ ...change })),
      getCurrentPathIndex() {
        return { ...currentPathIndex };
      },
      getCurrentPaths() {
        return getCurrentPaths();
      },
      getIndex(name) {
        return handlerStates.get(name);
      },
      getWatchedPaths() {
        return [...configuredHandler.patterns];
      },
      handlerName: configuredHandler.name,
      handlerPatterns: [...configuredHandler.patterns],
      projectRoot,
      runtimeParams
    };
  }

  function getCurrentMatchingChanges(compiledPatternSet) {
    return getCurrentPaths()
      .filter((projectPath) => matchesCompiledPatterns(compiledPatternSet, projectPath))
      .map((projectPath) => createCurrentChangeFromProjectPath(projectPath));
  }

  async function initializeHandlers() {
    handlerStates.clear();

    for (const configuredHandler of configuredHandlers) {
      await configuredHandler.instance.onStart(
        createHandlerContext(
          configuredHandler,
          getCurrentMatchingChanges(configuredHandler.compiledPatterns)
        )
      );
      handlerStates.set(configuredHandler.name, configuredHandler.instance.getState());
    }
  }

  async function notifyHandlers(changes) {
    if (!Array.isArray(changes) || changes.length === 0) {
      return;
    }

    for (const configuredHandler of configuredHandlers) {
      const matchingChanges = changes.filter(
        (change) =>
          change.projectPath &&
          matchesCompiledPatterns(configuredHandler.compiledPatterns, change.projectPath)
      );

      if (matchingChanges.length === 0) {
        continue;
      }

      await configuredHandler.instance.onChanges(createHandlerContext(configuredHandler, matchingChanges));
      handlerStates.set(configuredHandler.name, configuredHandler.instance.getState());
    }
  }

  function removeDirectoryWatchersUnder(directoryPath) {
    const prefix = `${directoryPath}${path.sep}`;

    for (const [watchedPath, watcher] of directoryWatchers.entries()) {
      if (watchedPath === directoryPath || watchedPath.startsWith(prefix)) {
        watcher.close();
        directoryWatchers.delete(watchedPath);
      }
    }
  }

  function schedulePathSync(targetPath) {
    if (targetPath) {
      pendingChangedPaths.add(targetPath);
    }

    if (pathSyncTimer) {
      clearTimeout(pathSyncTimer);
    }

    pathSyncTimer = setTimeout(() => {
      pathSyncTimer = null;
      void processPendingPathChangesSafely();
    }, REFRESH_DEBOUNCE_MS);
  }

  function watchDirectory(directoryPath) {
    if (directoryWatchers.has(directoryPath)) {
      return;
    }

    try {
      const watcher = fs.watch(directoryPath, (_eventType, fileName) => {
        if (!fileName) {
          schedulePathSync(directoryPath);
          return;
        }

        schedulePathSync(path.join(directoryPath, String(fileName)));
      });

      watcher.on("error", () => {
        watcher.close();
        directoryWatchers.delete(directoryPath);
        schedulePathSync(directoryPath);
      });

      directoryWatchers.set(directoryPath, watcher);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  function watchDirectoryTree(startDir) {
    const directories = new Set();
    walkDirectories(startDir, directories);

    for (const directoryPath of directories) {
      watchDirectory(directoryPath);
    }
  }

  function closeRemovedWatchers(nextDirectorySet) {
    for (const [directoryPath, watcher] of directoryWatchers.entries()) {
      if (nextDirectorySet.has(directoryPath)) {
        continue;
      }

      watcher.close();
      directoryWatchers.delete(directoryPath);
    }
  }

  function syncAbsolutePath(targetPath) {
    const stats = tryStat(targetPath);

    if (!stats) {
      const deletedPath = inferDeletedProjectPath(
        projectRoot,
        targetPath,
        currentPathIndex,
        runtimeParams
      );
      removeDirectoryWatchersUnder(targetPath);
      return removeCurrentEntries(deletedPath.projectPath);
    }

    let changed = removeCurrentEntries(
      toProjectPath(projectRoot, targetPath, {
        isDirectory: stats.isDirectory(),
        runtimeParams
      })
    );

    if (stats.isDirectory()) {
      watchDirectoryTree(targetPath);
      changed = upsertCurrentEntry(targetPath, { isDirectory: true }) || changed;

      const directories = new Set();
      walkDirectories(targetPath, directories);
      directories.forEach((directoryPath) => {
        changed = upsertCurrentEntry(directoryPath, { isDirectory: true }) || changed;
      });

      walkFiles(targetPath, (filePath) => {
        changed = upsertCurrentEntry(filePath) || changed;
      });

      return changed;
    }

    removeDirectoryWatchersUnder(targetPath);
    return upsertCurrentEntry(targetPath) || changed;
  }

  async function refresh() {
    if (refreshInProgress || pathSyncInProgress) {
      pendingRefresh = true;
      return;
    }

    refreshInProgress = true;

    try {
      const nextConfig = loadWatchdogConfig(configPath);
      configuredHandlers = await loadConfiguredHandlers(
        handlerDir,
        nextConfig.handlers,
        projectRoot,
        runtimeParams
      );
      compiledPatterns = createCompiledPatterns(nextConfig.patterns);
      lastConfigSignature = getStatsSignature(tryStat(configPath));
      rebuildCurrentPathIndex();

      const nextDirectories = new Set();

      for (const { pattern } of compiledPatterns) {
        const fixedPrefix = getFixedPatternPrefix(pattern);

        for (const scanRoot of listProjectScanRoots(projectRoot, fixedPrefix, runtimeParams)) {
          const baseDirectory = getExistingWatchBase(scanRoot);
          walkDirectories(baseDirectory, nextDirectories);
        }
      }

      closeRemovedWatchers(nextDirectories);

      for (const directoryPath of nextDirectories) {
        watchDirectory(directoryPath);
      }

      await initializeHandlers();
    } finally {
      refreshInProgress = false;

      if (pendingRefresh) {
        pendingRefresh = false;
        await refresh();
      }
    }
  }

  async function refreshSafely() {
    try {
      await refresh();
    } catch (error) {
      console.error("Failed to refresh watchdog state.");
      console.error(error);
    }
  }

  async function processPendingPathChanges() {
    if (pathSyncInProgress || refreshInProgress) {
      if (refreshInProgress) {
        schedulePathSync();
      }

      return;
    }

    pathSyncInProgress = true;

    try {
      const pathsToSync = [...pendingChangedPaths];
      pendingChangedPaths.clear();

      if (pathsToSync.length === 0) {
        return;
      }

      let changed = false;
      const changes = [];

      for (const targetPath of pathsToSync) {
        changes.push(createChangeEvent(targetPath));

        if (syncAbsolutePath(targetPath)) {
          changed = true;
        }
      }

      if (changed || changes.length > 0) {
        await notifyHandlers(changes);
      }
    } finally {
      pathSyncInProgress = false;

      if (pendingRefresh) {
        pendingRefresh = false;
        await refresh();
        return;
      }

      if (pendingChangedPaths.size > 0) {
        schedulePathSync();
      }
    }
  }

  async function processPendingPathChangesSafely() {
    try {
      await processPendingPathChanges();
    } catch (error) {
      console.error("Failed to apply watched file changes incrementally.");
      console.error(error);
      scheduleRefresh();
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }

    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refreshSafely();
    }, REFRESH_DEBOUNCE_MS);
  }

  function startConfigWatcher() {
    configWatcher = (currentStats) => {
      const nextConfigSignature = getStatsSignature(currentStats);

      if (!nextConfigSignature || nextConfigSignature === lastConfigSignature) {
        return;
      }

      lastConfigSignature = nextConfigSignature;
      scheduleRefresh();
    };

    fs.watchFile(configPath, { interval: Math.max(REFRESH_DEBOUNCE_MS, 100) }, configWatcher);
  }

  function startReconcileLoop() {
    if (!Number.isFinite(reconcileIntervalMs) || reconcileIntervalMs <= 0) {
      return;
    }

    reconcileTimer = setInterval(() => {
      void refreshSafely();
    }, reconcileIntervalMs);
  }

  function getConfiguredHandlers() {
    return configuredHandlers.map((handler) => ({
      name: handler.name,
      patterns: [...handler.patterns]
    }));
  }

  function getWatchConfig() {
    return {
      handlers: getConfiguredHandlers()
    };
  }

  function getPathIndex() {
    return handlerStates.get("path_index") || Object.create(null);
  }

  return {
    covers(projectPath) {
      return matchesCompiledPatterns(compiledPatterns, projectPath);
    },
    getConfiguredHandlers,
    getIndex(name) {
      return handlerStates.get(name);
    },
    getPaths() {
      return Object.keys(getPathIndex()).sort((left, right) => left.localeCompare(right));
    },
    getWatchConfig,
    hasPath(projectPath) {
      const pathIndex = getPathIndex();
      return getProjectPathLookupCandidates(projectPath).some((candidate) => candidate && pathIndex[candidate]);
    },
    refresh,
    async start() {
      if (started) {
        return;
      }

      await refresh();

      if (watchConfig) {
        startConfigWatcher();
      }

      startReconcileLoop();
      started = true;
    },
    stop() {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }

      if (pathSyncTimer) {
        clearTimeout(pathSyncTimer);
        pathSyncTimer = null;
      }

      if (configWatcher) {
        fs.unwatchFile(configPath, configWatcher);
        configWatcher = null;
      }

      if (reconcileTimer) {
        clearInterval(reconcileTimer);
        reconcileTimer = null;
      }

      for (const watcher of directoryWatchers.values()) {
        watcher.close();
      }

      directoryWatchers.clear();
      started = false;
    }
  };
}
