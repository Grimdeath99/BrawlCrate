using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace BrawlCrate.Mcp
{
    // Private, parent-owned IPC. The public MCP transport and SDK live in mcp/server.mjs.
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            var protocol = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
            Console.SetOut(Console.Error); // BrawlLib diagnostic writes must never reach protocol stdout.
            try
            {
                string root = null;
                bool allowWrite = false;
                for (int i = 0; i < args.Length; i++)
                {
                    if (args[i] == "--root" && root == null && i + 1 < args.Length) root = args[++i];
                    else if (args[i] == "--allow-write" && !allowWrite) allowWrite = true;
                    else throw new ArgumentException("Usage: BrawlCrate.Mcp.Worker.exe --root ABSOLUTE_DIRECTORY [--allow-write]");
                }
                var json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024, RecursionLimit = 64 };
                using (var session = new DocumentSession(root, allowWrite))
                using (var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true)))
                {
                    string line;
                    while ((line = ReadLine(input)) != null)
                    {
                        object id = null;
                        object response;
                        try
                        {
                            var request = json.DeserializeObject(line) as Dictionary<string, object>;
                            if (request == null || !request.TryGetValue("id", out id) || !request.ContainsKey("method") ||
                                !request.ContainsKey("arguments") || request.Count != 3)
                                throw new OperationException("INVALID_REQUEST", "Expected id, method and arguments.");
                            var arguments = request["arguments"] as Dictionary<string, object>;
                            if (!(request["method"] is string) || arguments == null)
                                throw new OperationException("INVALID_REQUEST", "Method must be a string and arguments an object.");
                            response = new { id, result = session.Execute((string)request["method"], arguments) };
                        }
                        catch (OperationException ex) { response = new { id, error = new { code = ex.Code, message = ex.Message } }; }
                        catch (UnauthorizedAccessException) { response = new { id, error = new { code = "ACCESS_DENIED", message = "The operating system denied access to the requested file." } }; }
                        catch (IOException ex) { response = new { id, error = new { code = "FILE_ERROR", message = ex.Message } }; }
                        catch (ArgumentException ex) { response = new { id, error = new { code = "INVALID_ARGUMENT", message = ex.Message } }; }
                        catch (Exception ex)
                        {
                            Console.Error.WriteLine(ex.GetType().Name + ": " + ex.Message);
                            response = new { id, error = new { code = "APPLICATION_ERROR", message = "BrawlLib could not complete this operation." } };
                        }
                        protocol.WriteLine(json.Serialize(response));
                    }
                }
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("BrawlCrate MCP worker: " + ex.Message);
                return 1;
            }
        }

        private static string ReadLine(TextReader input)
        {
            var result = new StringBuilder();
            int ch;
            while ((ch = input.Read()) != -1)
            {
                if (ch == '\n') return result.ToString();
                if (result.Length >= 1024 * 1024) throw new InvalidDataException("IPC request exceeds 1 MiB.");
                result.Append((char)ch);
            }
            return result.Length == 0 ? null : result.ToString();
        }
    }

    internal sealed class OperationException : Exception
    {
        public string Code { get; }
        public OperationException(string code, string message) : base(message) { Code = code; }
    }
}
