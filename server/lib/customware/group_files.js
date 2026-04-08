import fs from "node:fs";
import path from "node:path";

import {
  normalizeEntityId,
  resolveProjectAbsolutePath
} from "./layout.js";
import {
  parseSimpleYaml,
  serializeSimpleYaml
} from "../../../app/L0/_all/mod/_core/framework/js/yaml-lite.js";

const GROUP_WRITE_LAYER = "L1";

function normalizeStringList(values) {
  return [...new Set((Array.isArray(values) ? values : values ? [values] : [])
    .map((value) => normalizeEntityId(value))
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function getNormalizedGroupConfig(config = {}) {
  return {
    included_groups: normalizeStringList(config.included_groups),
    included_users: normalizeStringList(config.included_users),
    managing_groups: normalizeStringList(config.managing_groups),
    managing_users: normalizeStringList(config.managing_users)
  };
}

function buildGroupConfigAbsolutePath(projectRoot, groupId, runtimeParams = null) {
  const normalizedGroupId = normalizeEntityId(groupId);

  if (!normalizedGroupId) {
    throw new Error(`Invalid group id: ${String(groupId || "")}`);
  }

  return resolveProjectAbsolutePath(
    projectRoot,
    `/app/${GROUP_WRITE_LAYER}/${normalizedGroupId}/group.yaml`,
    runtimeParams
  );
}

function readGroupConfig(projectRoot, groupId, runtimeParams = null) {
  const filePath = buildGroupConfigAbsolutePath(projectRoot, groupId, runtimeParams);

  try {
    return parseSimpleYaml(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

function writeGroupConfig(projectRoot, groupId, config, runtimeParams = null) {
  const filePath = buildGroupConfigAbsolutePath(projectRoot, groupId, runtimeParams);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    serializeSimpleYaml(getNormalizedGroupConfig(config)),
    "utf8"
  );
  return filePath;
}

function createGroup(projectRoot, groupId, options = {}) {
  const runtimeParams = options.runtimeParams || null;
  const groupDir = path.dirname(buildGroupConfigAbsolutePath(projectRoot, groupId, runtimeParams));

  if (fs.existsSync(groupDir)) {
    if (!options.force) {
      throw new Error(`Group already exists: ${normalizeEntityId(groupId)}`);
    }

    fs.rmSync(groupDir, { force: true, recursive: true });
  }

  fs.mkdirSync(path.join(groupDir, "mod"), { recursive: true });
  writeGroupConfig(projectRoot, groupId, {}, runtimeParams);

  return {
    groupDir,
    groupId: normalizeEntityId(groupId),
    layer: GROUP_WRITE_LAYER
  };
}

function addGroupEntry(projectRoot, groupId, entryType, entryId, options = {}) {
  const runtimeParams = options.runtimeParams || null;
  const config = readGroupConfig(projectRoot, groupId, runtimeParams);
  const normalizedEntryType = String(entryType || "").trim().toLowerCase();
  const key =
    normalizedEntryType === "group"
      ? options.manager
        ? "managing_groups"
        : "included_groups"
      : normalizedEntryType === "user"
        ? options.manager
          ? "managing_users"
          : "included_users"
        : "";

  if (!key) {
    throw new Error(`Unsupported group entry type: ${String(entryType || "")}`);
  }

  return writeGroupConfig(projectRoot, groupId, {
    ...config,
    [key]: normalizeStringList([...(config[key] || []), entryId])
  }, runtimeParams);
}

function removeGroupEntry(projectRoot, groupId, entryType, entryId, options = {}) {
  const normalizedEntryId = normalizeEntityId(entryId);
  const runtimeParams = options.runtimeParams || null;
  const config = readGroupConfig(projectRoot, groupId, runtimeParams);
  const normalizedEntryType = String(entryType || "").trim().toLowerCase();
  const key =
    normalizedEntryType === "group"
      ? options.manager
        ? "managing_groups"
        : "included_groups"
      : normalizedEntryType === "user"
        ? options.manager
          ? "managing_users"
          : "included_users"
        : "";

  if (!key) {
    throw new Error(`Unsupported group entry type: ${String(entryType || "")}`);
  }

  const nextValues = normalizeStringList(config[key]).filter(
    (existingEntryId) => existingEntryId !== normalizedEntryId
  );

  return writeGroupConfig(projectRoot, groupId, {
    ...config,
    [key]: nextValues
  }, runtimeParams);
}

export {
  buildGroupConfigAbsolutePath,
  createGroup,
  getNormalizedGroupConfig,
  readGroupConfig,
  addGroupEntry,
  removeGroupEntry,
  writeGroupConfig
};
