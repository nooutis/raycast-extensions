import {
  ActionPanel,
  Action,
  Color,
  Icon,
  List,
  closeMainWindow,
  environment,
  showToast,
  Toast,
} from "@raycast/api";
import { runAppleScript, useCachedPromise } from "@raycast/utils";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { useState } from "react";

const execFileAsync = promisify(execFile);
const HELPER_PATH = path.join(environment.assetsPath, "window-helper");

interface RawWindowItem {
  appName?: string;
  windowTitle?: string;
  isMinimized?: boolean;
  appPath?: string;
  bundleId?: string;
  pid?: number;
  windowIndex?: number;
}

interface OmniWindowItem {
  id: string;
  pid: number;
  title: string;
  workspace?: {
    displayName?: string;
    number?: number;
    rawName?: string;
  };
}

interface WindowInstance {
  id: string;
  appName: string;
  windowTitle: string;
  isMinimized?: boolean;
  appPath?: string;
  bundleId?: string;
  pid?: number;
  windowIndex?: number;
  workspace?: string;
  omniId?: string;
}

// Check standard OmniWM CLI executable paths
function getOmniwmctlPath(): string | null {
  const candidates = [
    "/Applications/OmniWM.app/Contents/MacOS/omniwmctl",
    "/opt/homebrew/bin/omniwmctl",
    "/usr/local/bin/omniwmctl",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Optimized fallback script when native helper binary is unavailable
const OPTIMIZED_FALLBACK_SCRIPT = `
tell application "System Events"
  set res to {}
  set procs to (every application process whose background only is false)
  repeat with p in procs
    try
      set pName to name of p
      set wNames to name of every window of p
      repeat with wName in wNames
        if wName is not missing value and (wName as text) is not "" then
          set end of res to pName & ":::" & wName
        end if
      end repeat
    end try
  end repeat
  set AppleScript's text item delimiters to ASCII character 10
  return res as text
end tell
`;

// Match native window with OmniWM window info
function findOmniMatch(
  win: WindowInstance,
  omniWindows: OmniWindowItem[],
): OmniWindowItem | null {
  if (!win.pid) return null;
  const matches = omniWindows.filter((o) => o.pid === win.pid);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  // Exact title match
  let m = matches.find((o) => o.title === win.windowTitle);
  if (m) return m;

  // Prefix or substring match
  m = matches.find(
    (o) =>
      win.windowTitle.includes(o.title) || o.title.includes(win.windowTitle),
  );
  if (m) return m;

  // Word token overlap match for dynamic title suffixes (e.g. " – Page 7 of 77")
  let bestScore = 0;
  let bestMatch: OmniWindowItem | null = null;
  const winWords = new Set(
    win.windowTitle.toLowerCase().split(/[\s\-—_.,·/]+/),
  );
  for (const candidate of matches) {
    const candWords = candidate.title.toLowerCase().split(/[\s\-—_.,·/]+/);
    let common = 0;
    for (const w of candWords) {
      if (w.length > 2 && winWords.has(w)) common++;
    }
    if (common > bestScore) {
      bestScore = common;
      bestMatch = candidate;
    }
  }
  return bestMatch;
}

async function queryOmniWindows(omniPath: string): Promise<OmniWindowItem[]> {
  try {
    const { stdout } = await execFileAsync(
      omniPath,
      [
        "query",
        "windows",
        "--fields",
        "id,pid,title,workspace",
        "--format",
        "json",
      ],
      { timeout: 500 },
    );
    const parsed = JSON.parse(stdout);
    return parsed.result?.payload?.windows || [];
  } catch {
    return [];
  }
}

async function fetchWindows(): Promise<WindowInstance[]> {
  const omniPath = getOmniwmctlPath();

  // Run native window query and OmniWM query concurrently
  const [nativeResult, omniWindows] = await Promise.all([
    (async (): Promise<WindowInstance[]> => {
      // 1. Try native helper
      if (fs.existsSync(HELPER_PATH)) {
        try {
          const { stdout } = await execFileAsync(HELPER_PATH, ["list"], {
            maxBuffer: 10 * 1024 * 1024,
          });
          const raw = JSON.parse(stdout.trim() || "[]");
          if (Array.isArray(raw) && raw.length > 0) {
            return (raw as RawWindowItem[]).map((item, idx) => ({
              id: `${item.appName}-${item.pid ?? idx}-${item.windowIndex ?? idx}`,
              appName: item.appName || "Unknown App",
              windowTitle: item.windowTitle || "Untitled Window",
              isMinimized: Boolean(item.isMinimized),
              appPath: item.appPath || undefined,
              bundleId: item.bundleId || undefined,
              pid: item.pid,
              windowIndex: item.windowIndex,
            }));
          }
        } catch {
          // Continue to fallback
        }
      }

      // 2. High-speed batch AppleScript fallback
      const stdout = await runAppleScript(OPTIMIZED_FALLBACK_SCRIPT);
      const lines = stdout.split("\n").filter(Boolean);

      return lines.map((line, idx): WindowInstance => {
        const [appName, ...titleParts] = line.split(":::");
        return {
          id: `${appName}-${idx}`,
          appName: appName?.trim() || "Unknown App",
          windowTitle: titleParts.join(":::")?.trim() || "Untitled Window",
        };
      });
    })(),
    omniPath ? queryOmniWindows(omniPath) : Promise.resolve([]),
  ]);

  // Merge OmniWM workspace & window ID
  if (omniWindows.length > 0) {
    for (const win of nativeResult) {
      const match = findOmniMatch(win, omniWindows);
      if (match) {
        win.omniId = match.id;
        const ws =
          match.workspace?.displayName ||
          (match.workspace?.number !== undefined
            ? String(match.workspace.number)
            : match.workspace?.rawName);
        if (ws) {
          win.workspace = ws;
        }
      }
    }
  }

  return nativeResult;
}

export default function Command() {
  const [selectedFilter, setSelectedFilter] = useState<string>("all");

  const {
    isLoading,
    data: instances = [],
    revalidate,
  } = useCachedPromise(fetchWindows, [], {
    keepPreviousData: true,
    onError: () => {
      showToast({
        style: Toast.Style.Failure,
        title: "Failed to load instances",
        message:
          "Ensure Raycast has Accessibility permissions in System Settings",
      });
    },
  });

  async function focusWindow(instance: WindowInstance) {
    await closeMainWindow();

    // 1. If OmniWM is available, focus via omniwmctl (handles workspace switching)
    const omniPath = getOmniwmctlPath();
    if (instance.omniId && omniPath) {
      try {
        await execFileAsync(omniPath, ["window", "focus", instance.omniId]);
        return;
      } catch {
        // Fallback to native helper
      }
    }

    // 2. Native helper focus
    if (
      instance.pid !== undefined &&
      instance.windowIndex !== undefined &&
      fs.existsSync(HELPER_PATH)
    ) {
      try {
        await execFileAsync(HELPER_PATH, [
          "focus",
          String(instance.pid),
          String(instance.windowIndex),
          instance.windowTitle,
        ]);
        return;
      } catch {
        // Fallback to AppleScript focus
      }
    }

    // 3. Fallback to AppleScript focus
    const focusScript = `
    tell application "System Events"
      tell process "${instance.appName}"
        set frontmost to true
        try
          perform action "AXRaise" of (first window whose name is "${instance.windowTitle.replace(/"/g, '\\"')}")
        end try
      end tell
    end tell
    `;
    try {
      await runAppleScript(focusScript);
    } catch (err) {
      showToast({
        style: Toast.Style.Failure,
        title: "Could not focus window",
        message: String(err),
      });
    }
  }

  async function switchWorkspace(workspace: string) {
    await closeMainWindow();
    const omniPath = getOmniwmctlPath();
    if (omniPath) {
      try {
        await execFileAsync(omniPath, [
          "command",
          "switch-workspace",
          workspace,
        ]);
      } catch {
        // Ignored
      }
    }
  }

  async function closeWindow(instance: WindowInstance) {
    const omniPath = getOmniwmctlPath();
    if (instance.omniId && omniPath) {
      try {
        await execFileAsync(omniPath, ["window", "close", instance.omniId]);
        showToast({ style: Toast.Style.Success, title: "Window closed" });
        revalidate();
        return;
      } catch {
        // Fallback
      }
    }

    if (
      instance.pid !== undefined &&
      instance.windowIndex !== undefined &&
      fs.existsSync(HELPER_PATH)
    ) {
      try {
        await execFileAsync(HELPER_PATH, [
          "close",
          String(instance.pid),
          String(instance.windowIndex),
          instance.windowTitle,
        ]);
        showToast({ style: Toast.Style.Success, title: "Window closed" });
        revalidate();
        return;
      } catch {
        // Fallback
      }
    }

    const closeScript = `
    tell application "System Events"
      tell process "${instance.appName}"
        try
          click (first button of (first window whose name is "${instance.windowTitle.replace(/"/g, '\\"')}") whose subrole is "AXCloseButton")
        end try
      end tell
    end tell
    `;
    try {
      await runAppleScript(closeScript);
      showToast({ style: Toast.Style.Success, title: "Window closed" });
      revalidate();
    } catch (err) {
      showToast({
        style: Toast.Style.Failure,
        title: "Could not close window",
        message: String(err),
      });
    }
  }

  const apps = Array.from(new Set(instances.map((i) => i.appName))).sort();
  const workspaces = Array.from(
    new Set(
      instances.map((i) => i.workspace).filter((w): w is string => Boolean(w)),
    ),
  ).sort((a, b) => {
    const numA = parseInt(a, 10);
    const numB = parseInt(b, 10);
    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
    return a.localeCompare(b);
  });

  const filteredInstances = instances.filter((item) => {
    if (selectedFilter === "all") return true;
    if (selectedFilter.startsWith("ws:")) {
      return item.workspace === selectedFilter.replace("ws:", "");
    }
    if (selectedFilter.startsWith("app:")) {
      return item.appName === selectedFilter.replace("app:", "");
    }
    return true;
  });

  return (
    <List
      isLoading={isLoading && instances.length === 0}
      searchBarPlaceholder="Search instances, windows, or workspaces..."
      searchBarAccessory={
        <List.Dropdown
          tooltip="Filter Windows"
          value={selectedFilter}
          onChange={(newVal) => setSelectedFilter(newVal)}
        >
          <List.Dropdown.Item
            title="All Windows"
            value="all"
            icon={Icon.AppWindowList}
          />
          {workspaces.length > 0 && (
            <List.Dropdown.Section title="OmniWM Workspaces">
              {workspaces.map((ws) => (
                <List.Dropdown.Item
                  key={`ws:${ws}`}
                  title={`Workspace ${ws}`}
                  value={`ws:${ws}`}
                  icon={Icon.Layers}
                />
              ))}
            </List.Dropdown.Section>
          )}
          <List.Dropdown.Section title="Applications">
            {apps.map((app) => (
              <List.Dropdown.Item
                key={`app:${app}`}
                title={app}
                value={`app:${app}`}
              />
            ))}
          </List.Dropdown.Section>
        </List.Dropdown>
      }
    >
      {filteredInstances.map((item) => (
        <List.Item
          key={item.id}
          icon={item.appPath ? { fileIcon: item.appPath } : Icon.Window}
          title={item.windowTitle}
          subtitle={item.appName}
          keywords={
            item.workspace
              ? [
                  item.workspace,
                  `ws ${item.workspace}`,
                  `ws${item.workspace}`,
                  `workspace ${item.workspace}`,
                ]
              : undefined
          }
          accessories={[
            ...(item.workspace
              ? [
                  {
                    tag: {
                      value: `WS ${item.workspace}`,
                      color: Color.Purple,
                    },
                    icon: Icon.Layers,
                    tooltip: `OmniWM Workspace: ${item.workspace}`,
                  },
                ]
              : []),
            ...(item.isMinimized
              ? [
                  {
                    tag: { value: "Minimized", color: Color.SecondaryText },
                    icon: Icon.EyeDisabled,
                    tooltip: "Window is currently minimized",
                  },
                ]
              : []),
          ]}
          actions={
            <ActionPanel>
              <Action
                title="Focus Window"
                icon={Icon.Eye}
                onAction={() => focusWindow(item)}
              />
              {item.workspace && (
                <Action
                  title={`Switch to Workspace ${item.workspace}`}
                  icon={Icon.Layers}
                  shortcut={{ modifiers: ["cmd", "opt"], key: "w" }}
                  onAction={() => switchWorkspace(item.workspace!)}
                />
              )}
              <Action
                title="Close Window"
                icon={Icon.XMarkCircle}
                shortcut={{ modifiers: ["cmd", "shift"], key: "w" }}
                onAction={() => closeWindow(item)}
              />
              <Action
                title="Reload Windows"
                icon={Icon.ArrowClockwise}
                shortcut={{ modifiers: ["cmd"], key: "r" }}
                onAction={revalidate}
              />
              <Action.CopyToClipboard
                title="Copy Window Title"
                content={item.windowTitle}
                shortcut={{ modifiers: ["cmd"], key: "c" }}
              />
              <Action.CopyToClipboard
                title="Copy App Name"
                content={item.appName}
                shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
              />
              {item.workspace && (
                <Action.CopyToClipboard
                  title="Copy Workspace"
                  content={item.workspace}
                />
              )}
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
