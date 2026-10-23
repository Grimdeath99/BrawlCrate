using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using BrawlLib.Internal.IO;
using BrawlLib.SSBB.ResourceNodes;

namespace BrawlCrate.Mcp
{
    // The desktop application accepts many unsafe legacy parsers. The MCP worker deliberately
    // admits only these fully checked formats, then initializes the real BrawlLib node types.
    public static class ResourcePreflight
    {
        public const int MaximumFileBytes = 64 * 1024 * 1024;
        public const int MaximumNodes = 4096;
        public const int MaximumDepth = 16;
        public const int MaximumMessages = 16384;
        public const int MaximumMessageBytes = 512;
        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);

        public static string Validate(byte[] data, string format)
        {
            if (data == null || data.Length < 4 || data.Length > MaximumFileBytes)
                throw new InvalidDataException("Resource size must be between 4 bytes and 64 MiB.");
            string actual = IsArc(data, 0, data.Length) ? "arc" : "msbin";
            if (!string.IsNullOrEmpty(format) && !string.Equals(format, "auto", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(format, actual, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("The resource does not match the requested supported format.");
            int nodes = 0;
            ValidateNode(data, 0, data.Length, 0, ref nodes);
            return actual;
        }

        public static void ValidateMessageText(string text)
        {
            if (text == null || text.Length > MaximumMessageBytes)
                throw new InvalidDataException("Message text must contain at most 512 UTF-8 bytes.");
            foreach (char character in text)
            {
                if (character == '<' || character == '[' || character == '\\' ||
                    (char.IsControl(character) && character != '\n'))
                    throw new InvalidDataException("Only plain message text is supported: no markup, escapes, or controls except LF newlines.");
            }
            try
            {
                if (StrictUtf8.GetByteCount(text) > MaximumMessageBytes)
                    throw new InvalidDataException("Message text must contain at most 512 UTF-8 bytes.");
            }
            catch (EncoderFallbackException exception)
            {
                throw new InvalidDataException("Message text must be valid Unicode.", exception);
            }
        }

        public static unsafe ResourceNode Load(byte[] validatedBytes, string format)
        {
            string actual = Validate(validatedBytes, format);
            FileMap map = FileMap.FromTempFile(validatedBytes.Length);
            ResourceNode root = actual == "arc" ? (ResourceNode)new ARCNode() : new MSBinNode();
            try
            {
                Marshal.Copy(validatedBytes, 0, (IntPtr)map.Address, validatedBytes.Length);
                root.Initialize(null, new DataSource(map));
                if (root is ARCNode archive)
                    PopulateTyped(archive, validatedBytes, 0);
                return root;
            }
            catch
            {
                root.Dispose();
                map.Dispose();
                throw;
            }
        }

        private static unsafe void PopulateTyped(ARCNode archive, byte[] data, int dataStart)
        {
            // Prevent ARCNode.OnPopulate from probing unrelated legacy formats.
            archive._children = new List<ResourceNode>();
            int count = Read16(data, dataStart + 6);
            int relative = 64;
            for (int index = 0; index < count; index++)
            {
                int length = (int)Read32(data, dataStart + relative + 4);
                int payload = relative + 32;
                ResourceNode child = IsArc(data, dataStart + payload, length)
                    ? (ResourceNode)new ARCNode() : new MSBinNode();
                child.Initialize(archive, new DataSource(archive.WorkingUncompressed.Address + payload, length));
                if (child is ARCNode nested)
                    PopulateTyped(nested, data, dataStart + payload);
                relative = payload + Align32(length);
            }
        }

        private static void ValidateNode(byte[] data, int start, int length, int depth, ref int nodes)
        {
            if (depth > MaximumDepth || ++nodes > MaximumNodes)
                throw new InvalidDataException("Resource nesting or node count exceeds the supported limit.");
            if (IsArc(data, start, length))
                ValidateArc(data, start, length, depth, ref nodes);
            else
                ValidateMsbin(data, start, length);
        }

        private static void ValidateArc(byte[] data, int start, int length, int depth, ref int nodes)
        {
            if (length < 64 || data[start + 4] != 1 || data[start + 5] != 1)
                throw new InvalidDataException("ARC requires a complete 64-byte version 0x0101 header.");
            bool terminated = false;
            for (int index = 16; index < 64; index++)
            {
                byte value = data[start + index];
                if (value == 0) { terminated = true; break; }
                if (value < 0x20 || value > 0x7e)
                    throw new InvalidDataException("ARC names must use printable ASCII.");
            }
            if (!terminated)
                throw new InvalidDataException("ARC name must have a terminator within its 48-byte field.");
            int count = Read16(data, start + 6);
            if (count > MaximumNodes - nodes)
                throw new InvalidDataException("ARC node count exceeds the supported limit.");
            int relative = 64;
            for (int index = 0; index < count; index++)
            {
                if (relative > length - 32)
                    throw new InvalidDataException("ARC entry header extends beyond its archive.");
                uint payloadLength = Read32(data, start + relative + 4);
                if (payloadLength < 4 || payloadLength > length - relative - 32)
                    throw new InvalidDataException("ARC entry data is empty, truncated, or outside its archive.");
                if (Read16(data, start + relative + 10) != 0xffff)
                    throw new InvalidDataException("ARC redirect entries are not supported by this integration.");
                int alignedLength = Align32((int)payloadLength);
                int payload = relative + 32;
                if (alignedLength > length - payload)
                    throw new InvalidDataException("ARC entry alignment extends beyond its archive.");
                ValidateNode(data, start + payload, (int)payloadLength, depth + 1, ref nodes);
                relative = payload + alignedLength;
            }
            if (relative != length)
                throw new InvalidDataException("ARC has unexplained trailing data or an inconsistent entry count.");
        }

        private static void ValidateMsbin(byte[] data, int start, int length)
        {
            if (length < 4)
                throw new InvalidDataException("Unsupported entry: expected ARC or a complete MSBin offset table.");
            uint tableLength = Read32(data, start);
            if (tableLength < 4 || tableLength > length || tableLength % 4 != 0)
                throw new InvalidDataException("Unsupported entry or invalid MSBin offset table.");
            int count = (int)tableLength / 4 - 1;
            if (count > MaximumMessages)
                throw new InvalidDataException("MSBin message count exceeds the supported limit.");
            if (count > 0 && tableLength == length)
                throw new InvalidDataException("All-empty MSBin messages are not supported by the application reader.");
            int previous = (int)tableLength;
            for (int index = 1; index <= count; index++)
            {
                uint nextValue = Read32(data, start + index * 4);
                if (nextValue < previous || nextValue > length)
                    throw new InvalidDataException("MSBin offsets must be ordered and inside the resource.");
                int next = (int)nextValue;
                int textLength = next - previous;
                if (textLength > MaximumMessageBytes)
                    throw new InvalidDataException("MSBin messages must contain at most 512 UTF-8 bytes.");
                try
                {
                    ValidateMessageText(StrictUtf8.GetString(data, start + previous, textLength));
                }
                catch (DecoderFallbackException exception)
                {
                    throw new InvalidDataException("MSBin messages must contain valid UTF-8 text.", exception);
                }
                // BrawlLib's existing reader terminates at the first end-of-file offset.
                if (next == length && index != count)
                    throw new InvalidDataException("Trailing empty MSBin messages are not supported by the application reader.");
                previous = next;
            }
            if (previous != length)
                throw new InvalidDataException("MSBin final offset must equal the resource length.");
        }

        private static bool IsArc(byte[] data, int start, int length)
        {
            return length >= 4 && data[start] == 0x41 && data[start + 1] == 0x52 &&
                data[start + 2] == 0x43 && data[start + 3] == 0;
        }

        private static int Align32(int value) { return (value + 31) & ~31; }
        private static int Read16(byte[] data, int offset) { return (data[offset] << 8) | data[offset + 1]; }
        private static uint Read32(byte[] data, int offset)
        {
            return ((uint)data[offset] << 24) | ((uint)data[offset + 1] << 16) |
                ((uint)data[offset + 2] << 8) | data[offset + 3];
        }
    }
}
