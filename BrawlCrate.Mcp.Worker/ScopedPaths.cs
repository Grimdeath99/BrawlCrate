using System;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

namespace BrawlCrate.Mcp
{
    internal sealed class ScopedPaths
    {
        public string Root { get; }
        private static readonly Regex Reserved = new Regex(@"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])($|\.)", RegexOptions.IgnoreCase);

        public ScopedPaths(string root)
        {
            if (string.IsNullOrWhiteSpace(root) || !Path.IsPathRooted(root) || root.StartsWith(@"\\") ||
                root.Length < 3 || root[1] != ':' || (root[2] != '\\' && root[2] != '/'))
                throw new ArgumentException("--root must be an existing absolute local drive directory.");
            Root = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
            CheckAncestors(Root);
            if (!Directory.Exists(Root)) throw new DirectoryNotFoundException("The allowed root does not exist.");
        }

        public string Resolve(string relative, bool output)
        {
            if (string.IsNullOrWhiteSpace(relative) || relative.Length > 240 || Path.IsPathRooted(relative))
                throw Denied();
            string[] parts = relative.Replace('/', '\\').Split('\\');
            if (parts.Any(p => p.Length == 0 || p == "." || p == ".." || p.EndsWith(".") || p.EndsWith(" ") ||
                p.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || Reserved.IsMatch(p))) throw Denied();
            string full = Path.GetFullPath(Path.Combine(Root, relative));
            if (!full.StartsWith(Root, StringComparison.OrdinalIgnoreCase)) throw Denied();
            CheckAncestors(full);
            if (output)
            {
                if (!Directory.Exists(Path.GetDirectoryName(full)))
                    throw new OperationException("DIRECTORY_NOT_FOUND", "Export parent directory must already exist.");
                if (File.Exists(full) || Directory.Exists(full))
                    throw new OperationException("ALREADY_EXISTS", "Exports never overwrite existing paths. Choose a new path.");
            }
            else if (!File.Exists(full)) throw new OperationException("FILE_NOT_FOUND", "The requested file does not exist in the allowed root.");
            return full;
        }

        public string Relative(string full) => full.Substring(Root.Length).Replace('\\', '/');

        public static void CheckAncestors(string path)
        {
            string full = Path.GetFullPath(path);
            string cursor = Path.GetPathRoot(full);
            foreach (string part in full.Substring(cursor.Length).Split(new[] { '\\', '/' }, StringSplitOptions.RemoveEmptyEntries))
            {
                cursor = Path.Combine(cursor, part);
                // GetAttributes also detects dangling directory junctions; Exists alone can hide them.
                try
                {
                    if ((File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0) throw Denied();
                }
                catch (FileNotFoundException) { }
                catch (DirectoryNotFoundException) { }
            }
        }

        private static OperationException Denied() => new OperationException("PATH_DENIED", "Use a relative path within the allowed root, without traversal, device names or reparse points.");
    }
}
