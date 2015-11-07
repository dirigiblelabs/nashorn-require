/**
 * Copyright (c) 2015 Per Rovegard
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Nashorn globals
declare var print: (_: string) => void;
declare var load: (_: {name: string, script: string}) => any;

((global: any) => {
  var LineSeparator = java.lang.System.getProperty("line.separator");

  var moduleCache: { [id: string]: Module; } = {};
  var require = global.require = createRequire();
  // ----------------------

  interface RequireFunction {
    (id: string): ModuleExports
  }

  class Module {
    constructor(id: ModuleId, location: ModuleLocation) {
      this.id = id.id;
      this.location = location;
      this._exports = new ModuleExports();
    };

    private _exports: ModuleExports;
    id: string; //TODO: Not deletable
    get exports(): ModuleExports {
      return this._exports; //TODO: Make sure it's the correct 'this' reference
    }
    set exports(exp: ModuleExports) {
      //debugLog(`Setting exports for ${this.id}`);
      this._exports = exp; //TODO: Make sure it's the correct 'this' reference
      //moduleCache[this.id] = exp;
    }

    //TODO: Don't expose to module code!
    location: ModuleLocation;
  }

  class ModuleExports {

  }

  class ModuleId {
    id: string;

    constructor(id: string) {
      if (!id) throw new RequireError("Module ID cannot be empty");
      this.id = id;
    }

    isRelative(): boolean {
      return this.id[0] === "."; // ./ or ../
    }

    isAbsolutePath(): boolean {
      // Handle both Unix and Windows path, /foo/bar.js and c:\foo\bar.js
      return this.id[0] === "/" || this.id[1] === ":";
    }

    toString(): string {
      return this.id;
    }
  }

  class RequireError extends Error {
    constructor(message: string, cause?: any) {
      super(message);
      this.message = message;
      this.cause = cause;
    }

    cause: any;

    toString(): string {
      var str = this.message;
      if (this.cause) str = str + " [Caused by: " + this.cause + "]";
      return str;
    }
  }

  /**
   * The type of the global 'require' function
   */
  interface Require extends RequireFunction {
    root: string;
    debug: boolean;
    extensions: string[]
  }

  interface ModuleLocation {
    getStream(): java.io.InputStream;
    resolve(id: ModuleId): ModuleLocation;
    exists(): boolean;
    name: string
  }
  class FileSystemBasedModuleLocation implements ModuleLocation {
    file: java.io.File;
    name: string;

    constructor(file: java.io.File) {
      this.file = file;
      this.name = file.toString();
    }

    getStream() {
      return new java.io.FileInputStream(this.file);
    }

    resolve(id: ModuleId) {
      var parent = this.file.isDirectory() ? this.file : this.file.getParentFile();
      return new FileSystemBasedModuleLocation(newFile(parent, id.id));
    }

    exists() {
      return this.file.exists();
    }

    toString() {
      return "file " + this.name;
    }
  }

  function locateModule(id: ModuleId, parent?: Module): ModuleLocation {
    var action: (mid: ModuleId) => ModuleLocation;
    if (id.isAbsolutePath()) {
      // For an absolute path, just return a file stream provided that the file exists.
      action = (mid) => new FileSystemBasedModuleLocation(newFile(mid.id));
    } else if (id.isRelative() && parent) {
      // Resolve the id against the id of the parent module
      action = (mid) => parent.location.resolve(mid);
    } else {
      // Top-level ID, resolve against root (TODO: multiple roots)
      var tempLocation = new FileSystemBasedModuleLocation(newFile(require.root));
      action = (mid) => tempLocation.resolve(mid);
    }
    for (var i: number = 0; i < require.extensions.length; i++) {
      var ext = require.extensions[i];
      var newModuleId = new ModuleId(ensureExtension(id.id, ext));
      var location = action(newModuleId);
      if (!location) continue;
      debugLog(`Considering location: ${location}`);
      if (location.exists()) return location;
    }
    throw new RequireError(`Failed to locate module: ${id}`);
  }

  function doRequire(id: string, parent?: Module): ModuleExports {
    var moduleId = new ModuleId(id);
    var location = locateModule(moduleId, parent);
    return loadModule(moduleId, location);
  }

  function createRequire(): Require {
    var require = <Require>((id: string) => doRequire(id));
    require.root = java.lang.System.getProperty("user.dir");
    require.debug = false;
    require.extensions = [".js", ""];
    return require;
  }

  // endsWith - also ES6
  function endsWith(str: string, suffix: string): boolean {
    return str.length >= suffix.length && suffix === str.substr(str.length - suffix.length);
  }

  function debugLog(msg: any): void {
    if (require.debug) print("[require] " + msg);
  }

  function ensureExtension(path: string, extension: string): string {
    if (!extension) return path;
    if (extension[0] !== ".") extension = "." + extension;
    if (endsWith(path, extension)) return path;
    return path + extension;
  }

  function readLocation(location: ModuleLocation): string {
    try {
      return readFromStream(location.getStream());
    } catch (e) {
      throw new RequireError("Failed to read: " + location, e);
    }
  }

  function readFromStream(stream: java.io.InputStream): string {
    // more or less regular java code except for static types
    var
      buf: string = "",
      reader: java.io.Reader;
    try {
      reader = new java.io.BufferedReader(new java.io.InputStreamReader(stream));
      var line: string;
      while ((line = reader.readLine()) !== null) {
        // Make sure to add a line separator (stripped by readLine), so that line numbers are preserved and line
        // comments won't "hide" the remainder of the file.
        buf += line + LineSeparator;
      }
    } finally {
      if (reader) reader.close();
    }
    return buf;
  }

  function loadModule(id: ModuleId, location: ModuleLocation): ModuleExports {
    // Check the cache first. Use the location name since that is suppose to be stable regardless of how the module
    // was requested.
    var cachedModule = moduleCache[location.name];
    if (cachedModule) {
      debugLog(`Using cached module for ${id}`);
      return cachedModule.exports;
    }

    debugLog(`Loading module '${id}' from ${location}`);
    var body = readLocation(location);
    //TODO: , __filename, __dirname
    var wrappedBody = `var moduleFunction = function (exports, module, require) {${body}\n}; moduleFunction`;
    var func = load({
      name: location.name,
      script: wrappedBody
    });
    var module = new Module(id, location);
    var requireFn = <RequireFunction>((id: string) => doRequire(id, module));

    // Cache before loading so that cyclic dependencies won't be a problem.
    moduleCache[location.name] = module;

    //var moduleFile = newFile(descriptor.path);
    //var dirName = moduleFile.getParent();
    //var fileName = moduleFile.getName();
    //TODO: expose public part of module only!!
    func.apply(module, [module.exports, module, requireFn]);
    return module.exports;
  }

  function newFile(parent: string|java.io.File, child?: string) {
    var file: java.io.File;

    if (child) {
      // java.io.File doesn't necessarily recognize an absolute Windows path as an absolute child. Therefore we have
      // to handle that manually. Luckily, isAbsolute() works as expected!
      if (new java.io.File(child).isAbsolute()) file = new java.io.File(child);
      else file = new java.io.File(parent, child);
    } else if (parent) {
      file = new java.io.File(parent);
    } else {
      throw new Error("java.io.File takes one or two arguments");
    }

    // File.exists() works differently under Windows and Unix - on Unix all path parts must exist, even if a part is
    // "negated" by a subsequent ".." part, but Windows is more forgiving. To ensure consistent behavior across
    // system types, we use the canonical path for the final File instance.
    return new java.io.File(file.getCanonicalPath());
  }
})(this);
