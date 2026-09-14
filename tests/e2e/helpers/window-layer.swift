// Print the window-server view of every on-screen or off-screen window owned by a given pid.
//
// 🔴 Why an external reader instead of asking the child process itself (#940):
// the child could report `window.level()` from its own AppKit state, but that is
// self-reporting — it proves what the process *believes*, not what the window
// server actually applied. `CGWindowListCopyWindowInfo` reads the compositor's
// own record, so a level that never took effect shows up as a mismatch here.
//
// Output: one JSON object per line, so the caller can parse without a JSON
// dependency. `layer` is `kCGWindowLayer`: 0 = normal, 3 = floating
// (`NSFloatingWindowLevel`). Windows with no name are still printed — a plugin
// window that failed to take its title is exactly the case worth seeing.
//
// Usage: swift window-layer.swift <pid>

import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 2, let pid = Int(CommandLine.arguments[1]) else {
    FileHandle.standardError.write(Data("usage: window-layer.swift <pid>\n".utf8))
    exit(2)
}

guard let windows = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]]
else {
    FileHandle.standardError.write(Data("CGWindowListCopyWindowInfo returned nothing\n".utf8))
    exit(1)
}

for window in windows {
    guard let owner = window[kCGWindowOwnerPID as String] as? Int, owner == pid else { continue }
    let layer = window[kCGWindowLayer as String] as? Int ?? -1
    let name = window[kCGWindowName as String] as? String ?? ""
    let payload: [String: Any] = ["pid": owner, "layer": layer, "name": name]
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
        let line = String(data: data, encoding: .utf8)
    else { continue }
    print(line)
}
