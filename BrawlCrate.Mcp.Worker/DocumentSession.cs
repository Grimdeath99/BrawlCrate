using BrawlLib.SSBB.ResourceNodes;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace BrawlCrate.Mcp
{
    // This is the authoritative state of one explicitly headless application session.
    // All calls run sequentially on Program's STA thread; no UI objects or plugins are loaded.
    internal sealed class DocumentSession : IDisposable
    {
        private const int MaxBytes = 64 * 1024 * 1024;
        private readonly string _instance = Guid.NewGuid().ToString("N");
        private readonly ScopedPaths _paths;
        private readonly bool _allowWrite;
        private readonly Dictionary<string, Document> _documents = new Dictionary<string, Document>();
        private readonly Dictionary<string, Receipt> _receipts = new Dictionary<string, Receipt>();
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };

        public DocumentSession(string root, bool allowWrite) { _paths = new ScopedPaths(root); _allowWrite = allowWrite; }

        public object Execute(string method, Dictionary<string, object> args)
        {
            string[] keys;
            switch (method)
            {
                case "get_status": keys = new string[0]; break;
                case "open_document": keys = new[] { "path", "format" }; break;
                case "get_document": keys = new[] { "document_id" }; break;
                case "list_children":
                case "read_messages": keys = new[] { "document_id", "node_id", "offset", "limit" }; break;
                case "rename_node": keys = new[] { "document_id", "node_id", "name", "expected_revision", "operation_id" }; break;
                case "set_message": keys = new[] { "document_id", "node_id", "index", "text", "expected_revision", "operation_id" }; break;
                case "export_document": keys = new[] { "document_id", "path", "expected_revision", "operation_id" }; break;
                case "close_document": keys = new[] { "document_id", "discard_changes", "expected_revision", "operation_id" }; break;
                default: throw new OperationException("UNKNOWN_OPERATION", "Unknown application operation.");
            }
            if (args.Keys.Except(keys).Any()) throw new OperationException("INVALID_ARGUMENT", "Unknown argument.");
            bool mutation = method == "rename_node" || method == "set_message" || method == "export_document" || method == "close_document";
            string operationId = null, fingerprint = null;
            if (mutation)
            {
                operationId = Text(args, "operation_id", 128);
                fingerprint = method + ":" + _json.Serialize(new SortedDictionary<string, object>(args, StringComparer.Ordinal));
                if (_receipts.TryGetValue(operationId, out Receipt receipt))
                {
                    if (receipt.Fingerprint != fingerprint) throw new OperationException("OPERATION_CONFLICT", "operation_id was already used with different arguments.");
                    return receipt.Result;
                }
                if (_receipts.Count >= 1000 || (_receipts.Count >= 984 && (method == "rename_node" || method == "set_message")))
                    throw new OperationException("SESSION_LIMIT", "This session reached its mutation receipt limit. The last 16 receipts are reserved for exports and closes; start a new session for further edits.");
                if (method != "close_document" && !_allowWrite) throw new OperationException("READ_ONLY", "Restart with --allow-write to enable edits and exports.");
            }
            object result;
            switch (method)
            {
                case "get_status":
                    result = new { instance_id = _instance, mode = "headless", application = "BrawlCrate", brawllib_version = typeof(ResourceNode).Assembly.GetName().Version.ToString(), worker_version = "1.0.0", root = _paths.Root, allow_write = _allowWrite, supported_formats = new[] { "arc", "msbin" }, limits = new { max_file_bytes = MaxBytes, max_documents = 8, max_nodes = ResourcePreflight.MaximumNodes, max_depth = ResourcePreflight.MaximumDepth, max_page_size = 200, max_mutations = 1000 }, documents = _documents.Values.Select(Describe).ToArray() }; break;
                case "open_document": result = Open(args); break;
                default:
                    Document doc = Find(Text(args, "document_id", 64));
                    if (mutation && Number(args, "expected_revision", 0, int.MaxValue) != doc.Revision)
                        throw new OperationException("STALE_REVISION", "The document revision changed. Read get_document before editing again.");
                    switch (method)
                    {
                        case "get_document": result = Describe(doc); break;
                        case "list_children": result = ListChildren(doc, args); break;
                        case "read_messages": result = ReadMessages(doc, args); break;
                        case "rename_node": result = Rename(doc, args); break;
                        case "set_message": result = SetMessage(doc, args); break;
                        case "export_document": result = Export(doc, args); break;
                        case "close_document":
                            bool discard = Boolean(args, "discard_changes", false);
                            if (doc.Dirty && !discard) throw new OperationException("UNSAVED_CHANGES", "Export changes or explicitly discard this session document.");
                            doc.Root.Dispose();
                            _documents.Remove(doc.Id);
                            result = new { document_id = doc.Id, closed = true, discarded_changes = doc.Dirty, revision = doc.Revision }; break;
                        default: throw new InvalidOperationException();
                    }
                    break;
            }
            if (mutation) _receipts.Add(operationId, new Receipt { Fingerprint = fingerprint, Result = result });
            return result;
        }

        private object Open(Dictionary<string, object> args)
        {
            string path = _paths.Resolve(Text(args, "path", 240), false);
            string format = Text(args, "format", 8, "auto");
            if (format != "auto" && format != "arc" && format != "msbin") throw new OperationException("INVALID_ARGUMENT", "format must be auto, arc or msbin.");
            var existing = _documents.Values.FirstOrDefault(d => string.Equals(d.SourcePath, path, StringComparison.OrdinalIgnoreCase));
            if (existing != null)
            {
                if (format != "auto" && format != existing.Format)
                    throw new OperationException("UNSUPPORTED_OR_INVALID_FILE", "The open document does not match the requested format.");
                return Describe(existing);
            }
            if (_documents.Count >= 8) throw new OperationException("DOCUMENT_LIMIT", "Close a document before opening another (maximum 8).");
            byte[] bytes;
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (stream.Length < 4 || stream.Length > MaxBytes) throw new OperationException("FILE_SIZE", "File must be between 4 bytes and 64 MiB.");
                bytes = new byte[(int)stream.Length];
                int offset = 0, read;
                while (offset < bytes.Length && (read = stream.Read(bytes, offset, bytes.Length - offset)) > 0) offset += read;
                if (offset != bytes.Length) throw new IOException("File ended during read.");
            }
            try { format = ResourcePreflight.Validate(bytes, format); }
            catch (InvalidDataException ex) { throw new OperationException("UNSUPPORTED_OR_INVALID_FILE", ex.Message); }
            ResourceNode root = ResourcePreflight.Load(bytes, format);
            try
            {
                root._origPath = path;
                if (root is MSBinNode) root._name = Path.GetFileName(path);
                var doc = new Document { Id = Guid.NewGuid().ToString("N"), Root = root, SourcePath = path, SourceHash = Hash(bytes), Format = format };
                Index(doc, root, "root", 0);
                _documents.Add(doc.Id, doc);
                return Describe(doc);
            }
            catch { root.Dispose(); throw; }
        }

        private void Index(Document doc, ResourceNode node, string id, int depth)
        {
            if (depth > ResourcePreflight.MaximumDepth || doc.Nodes.Count >= ResourcePreflight.MaximumNodes)
                throw new OperationException("RESOURCE_LIMIT", "Document exceeds the supported node count or nesting limit.");
            doc.Nodes.Add(id, node);
            for (int i = 0; i < node.Children.Count; i++) Index(doc, node.Children[i], id == "root" ? i.ToString(CultureInfo.InvariantCulture) : id + "/" + i, depth + 1);
        }

        private object Describe(Document d) => new { document_id = d.Id, instance_id = _instance, source_path = _paths.Relative(d.SourcePath), source_sha256 = d.SourceHash, format = d.Format, revision = d.Revision, dirty = d.Dirty, last_export_path = d.LastExportPath, node_count = d.Nodes.Count, root = DescribeNode("root", d.Root) };
        private static object DescribeNode(string id, ResourceNode n) => new { node_id = id, name = n.Name, type = n.GetType().Name, resource_type = n.ResourceFileType.ToString(), child_count = n.Children.Count, uncompressed_bytes = n.WorkingUncompressed.Length };

        private object ListChildren(Document d, Dictionary<string, object> args)
        {
            string id = Text(args, "node_id", 256, "root");
            ResourceNode node = Node(d, id);
            int offset = Number(args, "offset", 0, int.MaxValue, 0), limit = Number(args, "limit", 1, 200, 50);
            object[] items = node.Children.Skip(offset).Take(limit).Select((n, i) => DescribeNode(id == "root" ? (offset + i).ToString(CultureInfo.InvariantCulture) : id + "/" + (offset + i), n)).ToArray();
            return new { document_id = d.Id, revision = d.Revision, node_id = id, total = node.Children.Count, offset, items, next_offset = offset + (long)items.Length < node.Children.Count ? (int?)(offset + items.Length) : null };
        }

        private object ReadMessages(Document d, Dictionary<string, object> args)
        {
            string id = Text(args, "node_id", 256, "root");
            var node = Node(d, id) as MSBinNode;
            if (node == null) throw new OperationException("WRONG_NODE_TYPE", "read_messages requires an MSBin node.");
            int offset = Number(args, "offset", 0, int.MaxValue, 0), limit = Number(args, "limit", 1, 200, 50);
            var items = node._strings.Skip(offset).Take(limit).Select((text, i) => new { index = offset + i, text }).ToArray();
            return new { document_id = d.Id, revision = d.Revision, node_id = id, total = node._strings.Count, offset, items, next_offset = offset + (long)items.Length < node._strings.Count ? (int?)(offset + items.Length) : null };
        }

        private object Rename(Document d, Dictionary<string, object> args)
        {
            string id = Text(args, "node_id", 256, "root"), name = Text(args, "name", 47);
            var node = Node(d, id) as ARCNode;
            if (node == null) throw new OperationException("WRONG_NODE_TYPE", "Only ARC header names can be renamed.");
            if (name.Any(c => c < 32 || c > 126 || c == '/' || c == '\\') || name.Trim().Length == 0)
                throw new OperationException("INVALID_NAME", "ARC names must be 1-47 printable ASCII characters, without slashes.");
            if (node.Parent != null && node.Parent.Children.Any(n => !ReferenceEquals(node, n) && string.Equals(n.Name, name, StringComparison.OrdinalIgnoreCase)))
                throw new OperationException("DUPLICATE_NAME", "A sibling already has that name.");
            node.Name = name;
            d.Dirty = true;
            d.Revision++;
            return new { document_id = d.Id, revision = d.Revision, node = DescribeNode(id, node) };
        }

        private object SetMessage(Document d, Dictionary<string, object> args)
        {
            string id = Text(args, "node_id", 256, "root");
            var node = Node(d, id) as MSBinNode;
            if (node == null) throw new OperationException("WRONG_NODE_TYPE", "set_message requires an MSBin node.");
            int index = Number(args, "index", 0, int.MaxValue);
            if (index >= node._strings.Count) throw new OperationException("INDEX_OUT_OF_RANGE", "Message index does not exist.");
            string value = Text(args, "text", 512, null, true).Replace("\r\n", "\n").Replace("\r", "\n");
            try { ResourcePreflight.ValidateMessageText(value); }
            catch (InvalidDataException ex) { throw new OperationException("INVALID_MESSAGE", ex.Message); }
            if (index == node._strings.Count - 1 && value.Length == 0)
                throw new OperationException("INVALID_MESSAGE", "The final MSBin message cannot be empty because the application reader drops trailing empty messages.");
            value = value.Replace("\n", "\r\n");
            node._strings[index] = value;
            node.SignalPropertyChange();
            d.Dirty = true;
            d.Revision++;
            return new { document_id = d.Id, revision = d.Revision, node_id = id, index, text = value };
        }

        private object Export(Document d, Dictionary<string, object> args)
        {
            string relative = Text(args, "path", 240), destination = _paths.Resolve(relative, true);
            // Reuse native rebuilding and binary serialization, avoiding the GUI-oriented Export(string)
            // overload which can swallow errors and display a modal dialog.
            d.Root.Merge();
            if (d.Root.WorkingSource.Length < 4 || d.Root.WorkingSource.Length > MaxBytes)
                throw new OperationException("FILE_SIZE", "Rebuilt document is outside the export size limit.");
            string temp = Path.Combine(Path.GetDirectoryName(destination), ".brawlcrate-mcp-" + Guid.NewGuid().ToString("N") + ".tmp");
            try
            {
                using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None))
                {
                    d.Root.Export(stream);
                    stream.Flush(true);
                }
                byte[] bytes = File.ReadAllBytes(temp);
                ResourcePreflight.Validate(bytes, d.Format);
                string hash = Hash(bytes);
                _paths.Resolve(relative, true); // Recheck immediately before the atomic, no-overwrite move.
                File.Move(temp, destination);
                d.LastExportPath = _paths.Relative(destination);
                d.Dirty = false;
                d.Root.IsDirty = false;
                d.Revision++;
                return new { document_id = d.Id, revision = d.Revision, path = d.LastExportPath, bytes = bytes.Length, sha256 = hash, source_sha256 = d.SourceHash };
            }
            finally { if (File.Exists(temp)) File.Delete(temp); }
        }

        private Document Find(string id)
        {
            if (!_documents.TryGetValue(id, out Document doc)) throw new OperationException("DOCUMENT_NOT_FOUND", "Document handle is not owned by this session or has been closed.");
            return doc;
        }
        private static ResourceNode Node(Document doc, string id)
        {
            if (!doc.Nodes.TryGetValue(id, out ResourceNode node)) throw new OperationException("NODE_NOT_FOUND", "Node handle does not exist in this document.");
            return node;
        }
        private static string Hash(byte[] bytes)
        {
            using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
        }
        private static string Text(Dictionary<string, object> args, string key, int max, string fallback = null, bool empty = false)
        {
            if (!args.TryGetValue(key, out object value) && fallback != null) return fallback;
            if (!(value is string result) || result.Length > max || (!empty && result.Length == 0))
                throw new OperationException("INVALID_ARGUMENT", key + " must be a string with " + (empty ? "0" : "1") + "-" + max + " characters.");
            return result;
        }
        private static int Number(Dictionary<string, object> args, string key, int min, int max, int? fallback = null)
        {
            if (!args.TryGetValue(key, out object value) && fallback.HasValue) return fallback.Value;
            if (!(value is int number) || number < min || number > max)
                throw new OperationException("INVALID_ARGUMENT", key + " must be an integer between " + min + " and " + max + ".");
            return number;
        }
        private static bool Boolean(Dictionary<string, object> args, string key, bool fallback)
        {
            if (!args.TryGetValue(key, out object value)) return fallback;
            if (!(value is bool boolean)) throw new OperationException("INVALID_ARGUMENT", key + " must be a boolean.");
            return boolean;
        }
        public void Dispose()
        {
            foreach (Document d in _documents.Values) d.Root.Dispose();
            _documents.Clear();
        }
        private sealed class Document
        {
            public string Id, SourcePath, SourceHash, Format, LastExportPath;
            public ResourceNode Root;
            public int Revision;
            public bool Dirty;
            public readonly Dictionary<string, ResourceNode> Nodes = new Dictionary<string, ResourceNode>();
        }
        private sealed class Receipt { public string Fingerprint; public object Result; }
    }
}
