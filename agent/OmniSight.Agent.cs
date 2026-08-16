using System;
using System.CodeDom.Compiler;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Management;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.CSharp;
using Microsoft.Win32;

[assembly: AssemblyTitle("OmniSight Agent")]
[assembly: AssemblyDescription("OmniSight Windows monitoring service")]
[assembly: AssemblyCompany("OmniSight")]
[assembly: AssemblyProduct("OmniSight Agent")]
[assembly: AssemblyVersion("1.4.2.0")]
[assembly: AssemblyFileVersion("1.4.2.0")]

namespace OmniSight.Agent
{
    internal static class AgentPaths
    {
        internal const string ServiceName = "OmniSightAgent";
        internal const string DisplayName = "OmniSight Agent";
        internal const string Version = "1.4.2";
        internal static readonly string DataDirectory = ResolveDirectory("OMNISIGHT_AGENT_DATA_DIR", Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "OmniSight"));
        internal static readonly string ConfigPath = Path.Combine(DataDirectory, "agent.json");
        internal static readonly string AgentIdPath = Path.Combine(DataDirectory, "agent.id");
        internal static readonly string LogDirectory = Path.Combine(DataDirectory, "logs");
        internal static readonly string LogPath = Path.Combine(LogDirectory, "agent.log");
        internal static readonly string InstallDirectory = ResolveDirectory("OMNISIGHT_AGENT_INSTALL_DIR", Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "OmniSight Agent"));
        internal static readonly string ExecutablePath = Path.Combine(InstallDirectory, "OmniSight.Agent.exe");

        private static string ResolveDirectory(string variable, string fallback)
        {
            string value = Environment.GetEnvironmentVariable(variable);
            return !string.IsNullOrWhiteSpace(value) && Path.IsPathRooted(value) ? Path.GetFullPath(value) : fallback;
        }
    }

    internal static class Program
    {
        private static int Main(string[] args)
        {
            string mode = args != null && args.Length > 0 ? args[0] : string.Empty;
            if (string.Equals(mode, "--console", StringComparison.OrdinalIgnoreCase)) return RunConsole();
            if (string.Equals(mode, "--update-helper", StringComparison.OrdinalIgnoreCase)) return AgentMaintenance.RunUpdate();
            if (string.Equals(mode, "--uninstall-helper", StringComparison.OrdinalIgnoreCase)) return AgentMaintenance.RunUninstall();
            try
            {
                ServiceBase.Run(new OmniSightAgentService());
                return 0;
            }
            catch (Exception error)
            {
                AgentLog.Error("service host failed: " + error);
                return 1;
            }
        }

        private static int RunConsole()
        {
            AgentRuntime runtime = new AgentRuntime();
            Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs eventArgs)
            {
                eventArgs.Cancel = true;
                runtime.RequestStop();
            };
            runtime.Run();
            return 0;
        }
    }

    internal sealed class OmniSightAgentService : ServiceBase
    {
        private AgentRuntime runtime;
        private Thread worker;

        internal OmniSightAgentService()
        {
            ServiceName = AgentPaths.ServiceName;
            CanStop = true;
            CanShutdown = true;
            AutoLog = false;
        }

        protected override void OnStart(string[] args)
        {
            try
            {
                AgentConfig.Load();
                runtime = new AgentRuntime();
                worker = new Thread(runtime.Run);
                worker.IsBackground = true;
                worker.Name = "OmniSightAgentWorker";
                worker.Start();
            }
            catch (Exception error)
            {
                AgentLog.Error("service start failed: " + error);
                throw;
            }
        }

        protected override void OnStop()
        {
            StopRuntime();
        }

        protected override void OnShutdown()
        {
            StopRuntime();
            base.OnShutdown();
        }

        private void StopRuntime()
        {
            if (runtime != null) runtime.RequestStop();
            if (worker != null && worker.IsAlive) worker.Join(TimeSpan.FromSeconds(20));
        }
    }

    internal sealed class AgentConfig
    {
        internal string Url;
        internal string Token;
        internal string Role;
        internal string AgentId;
        internal int Interval;
        internal bool InsecureTls;

        internal static AgentConfig Load()
        {
            if (!File.Exists(AgentPaths.ConfigPath)) throw new InvalidOperationException("agent configuration is missing");
            string json = File.ReadAllText(AgentPaths.ConfigPath, Encoding.UTF8);
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            Dictionary<string, object> values = serializer.Deserialize<Dictionary<string, object>>(json);
            AgentConfig config = new AgentConfig();
            config.Url = ReadString(values, "url").TrimEnd('/');
            config.Token = ReadString(values, "token");
            config.Role = ReadString(values, "role");
            config.AgentId = ReadString(values, "agentId");
            config.Interval = ReadInt(values, "interval", 15);
            config.InsecureTls = ReadBool(values, "insecureTls", false);
            if (string.IsNullOrWhiteSpace(config.Role)) config.Role = "windows";
            if (config.Interval < 5) config.Interval = 5;
            if (config.Interval > 300) config.Interval = 300;
            Uri uri;
            if (!Uri.TryCreate(config.Url, UriKind.Absolute, out uri) || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
                throw new InvalidOperationException("agent URL is invalid");
            if (string.IsNullOrWhiteSpace(config.Token)) throw new InvalidOperationException("agent token is missing");
            if (string.IsNullOrWhiteSpace(config.AgentId)) config.AgentId = LoadOrCreateAgentId();
            return config;
        }

        private static string LoadOrCreateAgentId()
        {
            try
            {
                if (File.Exists(AgentPaths.AgentIdPath))
                {
                    string existing = File.ReadAllText(AgentPaths.AgentIdPath, Encoding.ASCII).Trim();
                    if (existing.Length > 0) return existing;
                }
            }
            catch { }
            string id = Environment.MachineName + "-" + Guid.NewGuid().ToString("N").Substring(0, 8);
            Directory.CreateDirectory(AgentPaths.DataDirectory);
            File.WriteAllText(AgentPaths.AgentIdPath, id, Encoding.ASCII);
            return id;
        }

        private static string ReadString(Dictionary<string, object> values, string key)
        {
            object value;
            return values != null && values.TryGetValue(key, out value) && value != null ? Convert.ToString(value, CultureInfo.InvariantCulture) : string.Empty;
        }

        private static int ReadInt(Dictionary<string, object> values, string key, int fallback)
        {
            object value;
            int number;
            return values != null && values.TryGetValue(key, out value) && value != null && int.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), out number) ? number : fallback;
        }

        private static bool ReadBool(Dictionary<string, object> values, string key, bool fallback)
        {
            object value;
            bool parsed;
            if (values == null || !values.TryGetValue(key, out value) || value == null) return fallback;
            if (value is bool) return (bool)value;
            return bool.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), out parsed) ? parsed : fallback;
        }
    }

    internal static class AgentLog
    {
        private static readonly object Sync = new object();

        internal static void Info(string message)
        {
            Write("INFO", message);
        }

        internal static void Error(string message)
        {
            Write("ERROR", message);
        }

        private static void Write(string level, string message)
        {
            try
            {
                lock (Sync)
                {
                    Directory.CreateDirectory(AgentPaths.LogDirectory);
                    if (File.Exists(AgentPaths.LogPath) && new FileInfo(AgentPaths.LogPath).Length > 2 * 1024 * 1024)
                    {
                        string previous = AgentPaths.LogPath + ".1";
                        if (File.Exists(previous)) File.Delete(previous);
                        File.Move(AgentPaths.LogPath, previous);
                    }
                    string line = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture) + " [" + level + "] " + message + Environment.NewLine;
                    File.AppendAllText(AgentPaths.LogPath, line, new UTF8Encoding(false));
                }
            }
            catch
            {
                try
                {
                    string fallbackPath = Path.Combine(Path.GetTempPath(), "OmniSightAgent-startup.log");
                    string fallbackLine = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture) + " [" + level + "] " + message + Environment.NewLine;
                    File.AppendAllText(fallbackPath, fallbackLine, new UTF8Encoding(false));
                }
                catch { }
            }
        }
    }

    internal static class LegacyTaskCleanup
    {
        internal static void Run()
        {
            RunScheduledTaskCommand("/End /TN \\\"OmniSightAgent\\\"");
            RunScheduledTaskCommand("/Delete /TN \\\"OmniSightAgent\\\" /F");
            TryDelete(Path.Combine(AgentPaths.DataDirectory, "run-agent.ps1"));
            TryDelete(Path.Combine(AgentPaths.DataDirectory, "omnisight-agent.ps1"));
        }

        private static void RunScheduledTaskCommand(string arguments)
        {
            try
            {
                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = Path.Combine(Environment.SystemDirectory, "schtasks.exe");
                startInfo.Arguments = arguments;
                startInfo.UseShellExecute = false;
                startInfo.CreateNoWindow = true;
                using (Process process = Process.Start(startInfo))
                {
                    if (process != null && !process.WaitForExit(10000)) process.Kill();
                }
            }
            catch { }
        }

        private static void TryDelete(string path)
        {
            try
            {
                if (File.Exists(path)) File.Delete(path);
            }
            catch { }
        }
    }

    internal sealed class AgentHttp
    {
        private readonly AgentConfig config;
        private readonly object requestSync = new object();
        private HttpWebRequest activeRequest;

        internal AgentHttp(AgentConfig config)
        {
            this.config = config;
            ServicePointManager.SecurityProtocol = ServicePointManager.SecurityProtocol | SecurityProtocolType.Tls12;
            ServicePointManager.Expect100Continue = false;
            if (config.InsecureTls)
            {
                ServicePointManager.ServerCertificateValidationCallback = delegate { return true; };
            }
        }

        internal string Send(string method, string path, object body, int timeoutSeconds)
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(config.Url + path);
            request.Method = method;
            request.Timeout = Math.Max(1000, timeoutSeconds * 1000);
            request.ReadWriteTimeout = request.Timeout;
            request.AllowAutoRedirect = true;
            request.UserAgent = "OmniSight-Agent/" + AgentPaths.Version;
            request.Headers["X-Agent-Token"] = config.Token;
            request.Accept = "text/plain, application/json";
            if (body != null)
            {
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                serializer.MaxJsonLength = 16 * 1024 * 1024;
                byte[] data = Encoding.UTF8.GetBytes(serializer.Serialize(body));
                request.ContentType = "application/json";
                request.ContentLength = data.Length;
                using (Stream stream = request.GetRequestStream()) stream.Write(data, 0, data.Length);
            }
            lock (requestSync) activeRequest = request;
            try
            {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    return reader.ReadToEnd();
                }
            }
            finally
            {
                lock (requestSync)
                {
                    if (ReferenceEquals(activeRequest, request)) activeRequest = null;
                }
            }
        }

        internal void Abort()
        {
            lock (requestSync)
            {
                if (activeRequest != null)
                {
                    try { activeRequest.Abort(); }
                    catch { }
                    activeRequest = null;
                }
            }
        }
    }

    internal sealed class AgentRuntime
    {
        private readonly ManualResetEvent stopEvent = new ManualResetEvent(false);
        private AgentHttp http;
        private WindowsCollector collector;

        internal void RequestStop()
        {
            stopEvent.Set();
            if (http != null) http.Abort();
        }

        internal void Run()
        {
            AgentConfig config;
            try
            {
                config = AgentConfig.Load();
                http = new AgentHttp(config);
                collector = new WindowsCollector(config);
                AgentLog.Info("OmniSight agent " + AgentPaths.Version + " starting as Windows service (id=" + config.AgentId + ", interval=" + config.Interval + "s)");
                LegacyTaskCleanup.Run();
            }
            catch (Exception error)
            {
                AgentLog.Error("startup failed: " + error.Message);
                return;
            }

            while (!stopEvent.WaitOne(0))
            {
                bool reportSent = false;
                try
                {
                    string response = http.Send("POST", "/api/agent/report", collector.BuildPayload(), 30);
                    HandleCommands(config, response);
                    reportSent = true;
                }
                catch (Exception error)
                {
                    if (!stopEvent.WaitOne(0)) AgentLog.Error("report failed: " + error.Message);
                }
                if (stopEvent.WaitOne(0)) break;
                if (!reportSent)
                {
                    stopEvent.WaitOne(TimeSpan.FromSeconds(config.Interval));
                    continue;
                }
                try
                {
                    string path = "/api/agent/commands?id=" + Uri.EscapeDataString(config.AgentId) + "&wait=" + config.Interval.ToString(CultureInfo.InvariantCulture);
                    string commands = http.Send("GET", path, null, config.Interval + 10);
                    HandleCommands(config, commands);
                }
                catch (Exception error)
                {
                    if (!stopEvent.WaitOne(0) && !(error is WebException)) AgentLog.Error("command poll failed: " + error.Message);
                }
            }
            AgentLog.Info("OmniSight agent stopped");
        }

        private void HandleCommands(AgentConfig config, string text)
        {
            if (string.IsNullOrEmpty(text)) return;
            string[] lines = text.Replace("\r", string.Empty).Split('\n');
            foreach (string rawLine in lines)
            {
                string[] parts = rawLine.Trim().Split('\t');
                if (parts.Length < 4 || parts[0] != "CMD") continue;
                string commandId = parts[1];
                string action = parts[2];
                string target = parts[3];
                string output = ExecuteCommand(action, target);
                SendResult(commandId, output);
                if (action == "agent_uninstall" && target == "self" && output.StartsWith("uninstall scheduled", StringComparison.OrdinalIgnoreCase))
                {
                    stopEvent.Set();
                    break;
                }
            }
        }

        private string ExecuteCommand(string action, string target)
        {
            if (!Regex.IsMatch(target ?? string.Empty, "^[a-zA-Z0-9@._:-]+$")) return "error: invalid command target";
            try
            {
                if (action == "status") return ServiceCommand(target, "status");
                if (action == "start") return ServiceCommand(target, "start");
                if (action == "stop") return ServiceCommand(target, "stop");
                if (action == "restart") return ServiceCommand(target, "restart");
                if (action == "agent_update") return AgentMaintenance.ScheduleHelper("--update-helper", "Windows service agent update scheduled");
                if (action == "agent_uninstall" && target == "self") return AgentMaintenance.ScheduleHelper("--uninstall-helper", "uninstall scheduled");
                return "unsupported action " + action;
            }
            catch (Exception error)
            {
                return "error: " + error.Message;
            }
        }

        private static string ServiceCommand(string target, string action)
        {
            using (ServiceController service = new ServiceController(target))
            {
                service.Refresh();
                if (action == "status") return service.ServiceName + " " + service.Status;
                if (action == "start")
                {
                    if (service.Status != ServiceControllerStatus.Running) service.Start();
                    service.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(30));
                    return "started " + target;
                }
                if (action == "stop")
                {
                    if (service.Status != ServiceControllerStatus.Stopped) service.Stop();
                    service.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30));
                    return "stopped " + target;
                }
                if (service.Status != ServiceControllerStatus.Stopped)
                {
                    service.Stop();
                    service.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30));
                }
                service.Start();
                service.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(30));
                return "restarted " + target;
            }
        }

        private void SendResult(string commandId, string output)
        {
            try
            {
                Dictionary<string, object> body = new Dictionary<string, object>();
                body["id"] = commandId;
                body["output"] = Convert.ToBase64String(Encoding.UTF8.GetBytes(output ?? string.Empty));
                http.Send("POST", "/api/agent/result", body, 20);
            }
            catch (Exception error)
            {
                AgentLog.Error("command result failed: " + error.Message);
            }
        }
    }

    internal sealed class WindowsCollector
    {
        private readonly AgentConfig config;
        private readonly object updateSync = new object();
        private Dictionary<string, object> updateStatus;
        private DateTime updateCheckedAt = DateTime.MinValue;

        internal WindowsCollector(AgentConfig config)
        {
            this.config = config;
        }

        internal Dictionary<string, object> BuildPayload()
        {
            Dictionary<string, object> os = QueryOperatingSystem();
            Dictionary<string, object> cpu = QueryCpu();
            Dictionary<string, object> disk = QueryDisk();
            Dictionary<string, object> metrics = new Dictionary<string, object>();
            metrics["diskIO"] = QueryDiskIo();
            metrics["bandwidth"] = QueryBandwidth();

            Dictionary<string, object> payload = new Dictionary<string, object>();
            payload["id"] = config.AgentId;
            payload["hostname"] = Environment.MachineName;
            payload["ip"] = FindIpv4Address();
            payload["os"] = ReadText(os, "Caption");
            payload["kernel"] = ReadText(os, "BuildNumber");
            payload["platform"] = "windows";
            payload["role"] = config.Role;
            payload["agentVersion"] = AgentPaths.Version;
            payload["interval"] = config.Interval;
            payload["uptime"] = CalculateUptime(os);
            payload["cpu"] = ReadNullableNumber(cpu, "LoadPercentage");
            payload["cores"] = ReadNullableNumber(cpu, "NumberOfLogicalProcessors");
            payload["mem"] = BuildMemory(os);
            payload["disk"] = BuildDisk(disk);
            payload["metrics"] = metrics;
            payload["updates"] = GetUpdateStatus();
            payload["services"] = QueryServices();
            return payload;
        }

        private static Dictionary<string, object> QueryOperatingSystem()
        {
            return QueryFirst("SELECT Caption, BuildNumber, LastBootUpTime, TotalVisibleMemorySize, FreePhysicalMemory FROM Win32_OperatingSystem");
        }

        private static Dictionary<string, object> QueryCpu()
        {
            double load = 0;
            double cores = 0;
            int loadSamples = 0;
            try
            {
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher("SELECT LoadPercentage, NumberOfLogicalProcessors FROM Win32_Processor"))
                using (ManagementObjectCollection rows = searcher.Get())
                {
                    foreach (ManagementObject row in rows)
                    {
                        double number;
                        if (TryNumber(row["LoadPercentage"], out number))
                        {
                            load += number;
                            loadSamples++;
                        }
                        if (TryNumber(row["NumberOfLogicalProcessors"], out number)) cores += number;
                        row.Dispose();
                    }
                }
            }
            catch { }
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["LoadPercentage"] = loadSamples > 0 ? (object)Math.Round(load / loadSamples, 2) : null;
            result["NumberOfLogicalProcessors"] = cores > 0 ? (object)Math.Round(cores, 0) : null;
            return result;
        }

        private static Dictionary<string, object> QueryDisk()
        {
            Dictionary<string, object> selected = new Dictionary<string, object>();
            string selectedId = null;
            try
            {
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher("SELECT DeviceID, Size, FreeSpace FROM Win32_LogicalDisk WHERE DriveType=3"))
                using (ManagementObjectCollection rows = searcher.Get())
                {
                    foreach (ManagementObject row in rows)
                    {
                        string id = Convert.ToString(row["DeviceID"], CultureInfo.InvariantCulture);
                        if (selectedId == null || string.Compare(id, selectedId, StringComparison.OrdinalIgnoreCase) < 0)
                        {
                            selectedId = id;
                            selected["Size"] = row["Size"];
                            selected["FreeSpace"] = row["FreeSpace"];
                        }
                        row.Dispose();
                    }
                }
            }
            catch { }
            return selected;
        }

        private static object BuildMemory(Dictionary<string, object> os)
        {
            double total;
            double free;
            if (!TryReadNumber(os, "TotalVisibleMemorySize", out total) || total <= 0) return null;
            if (!TryReadNumber(os, "FreePhysicalMemory", out free)) free = 0;
            Dictionary<string, object> memory = new Dictionary<string, object>();
            memory["totalKB"] = Math.Round(total);
            memory["usedKB"] = Math.Round(Math.Max(0, total - free));
            return memory;
        }

        private static object BuildDisk(Dictionary<string, object> disk)
        {
            double total;
            double free;
            if (!TryReadNumber(disk, "Size", out total) || total <= 0) return null;
            if (!TryReadNumber(disk, "FreeSpace", out free)) free = 0;
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["totalKB"] = Math.Round(total / 1024);
            result["usedKB"] = Math.Round(Math.Max(0, total - free) / 1024);
            return result;
        }

        private static long CalculateUptime(Dictionary<string, object> os)
        {
            try
            {
                string value = ReadText(os, "LastBootUpTime");
                if (value.Length == 0) return 0;
                DateTime boot = ManagementDateTimeConverter.ToDateTime(value);
                return Math.Max(0, (long)(DateTime.Now - boot).TotalSeconds);
            }
            catch { return 0; }
        }

        private static object QueryDiskIo()
        {
            double read = 0;
            double write = 0;
            int count = 0;
            try
            {
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher("SELECT Name, DiskReadBytesPerSec, DiskWriteBytesPerSec FROM Win32_PerfFormattedData_PerfDisk_PhysicalDisk"))
                using (ManagementObjectCollection rows = searcher.Get())
                {
                    foreach (ManagementObject row in rows)
                    {
                        if (string.Equals(Convert.ToString(row["Name"]), "_Total", StringComparison.OrdinalIgnoreCase))
                        {
                            row.Dispose();
                            continue;
                        }
                        double number;
                        if (TryNumber(row["DiskReadBytesPerSec"], out number)) read += number;
                        if (TryNumber(row["DiskWriteBytesPerSec"], out number)) write += number;
                        count++;
                        row.Dispose();
                    }
                }
            }
            catch { return null; }
            if (count == 0) return null;
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["readBps"] = Math.Max(0, Math.Round(read));
            result["writeBps"] = Math.Max(0, Math.Round(write));
            return result;
        }

        private static object QueryBandwidth()
        {
            double receive = 0;
            double send = 0;
            int count = 0;
            try
            {
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher("SELECT Name, BytesReceivedPerSec, BytesSentPerSec FROM Win32_PerfFormattedData_Tcpip_NetworkInterface"))
                using (ManagementObjectCollection rows = searcher.Get())
                {
                    foreach (ManagementObject row in rows)
                    {
                        string name = Convert.ToString(row["Name"], CultureInfo.InvariantCulture);
                        if (Regex.IsMatch(name ?? string.Empty, "loopback|isatap|teredo|bluetooth|tunnel|pseudo", RegexOptions.IgnoreCase))
                        {
                            row.Dispose();
                            continue;
                        }
                        double number;
                        if (TryNumber(row["BytesReceivedPerSec"], out number)) receive += number;
                        if (TryNumber(row["BytesSentPerSec"], out number)) send += number;
                        count++;
                        row.Dispose();
                    }
                }
            }
            catch { return null; }
            if (count == 0) return null;
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["rxBps"] = Math.Max(0, Math.Round(receive));
            result["txBps"] = Math.Max(0, Math.Round(send));
            return result;
        }

        private Dictionary<string, object> GetUpdateStatus()
        {
            lock (updateSync)
            {
                if (updateStatus != null && DateTime.UtcNow - updateCheckedAt < TimeSpan.FromMinutes(30)) return updateStatus;
                object session = null;
                object searcher = null;
                object searchResult = null;
                object updates = null;
                int? count = null;
                string source = "windows-update";
                try
                {
                    Type sessionType = Type.GetTypeFromProgID("Microsoft.Update.Session");
                    if (sessionType == null) throw new InvalidOperationException("Windows Update API is unavailable");
                    session = Activator.CreateInstance(sessionType);
                    searcher = session.GetType().InvokeMember("CreateUpdateSearcher", BindingFlags.InvokeMethod, null, session, null, CultureInfo.InvariantCulture);
                    searchResult = searcher.GetType().InvokeMember("Search", BindingFlags.InvokeMethod, null, searcher, new object[] { "IsInstalled=0 and IsHidden=0" }, CultureInfo.InvariantCulture);
                    updates = searchResult.GetType().InvokeMember("Updates", BindingFlags.GetProperty, null, searchResult, null, CultureInfo.InvariantCulture);
                    object rawCount = updates.GetType().InvokeMember("Count", BindingFlags.GetProperty, null, updates, null, CultureInfo.InvariantCulture);
                    count = Convert.ToInt32(rawCount, CultureInfo.InvariantCulture);
                }
                catch
                {
                    source = "unavailable";
                }
                finally
                {
                    ReleaseCom(updates);
                    ReleaseCom(searchResult);
                    ReleaseCom(searcher);
                    ReleaseCom(session);
                }
                bool rebootRequired = QueryRebootRequired();
                long checkedAt = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalSeconds;
                updateStatus = new Dictionary<string, object>();
                updateStatus["count"] = count.HasValue ? (object)count.Value : null;
                updateStatus["rebootRequired"] = rebootRequired;
                updateStatus["source"] = source;
                updateStatus["checkedAt"] = checkedAt;
                updateCheckedAt = DateTime.UtcNow;
                return updateStatus;
            }
        }

        private static bool QueryRebootRequired()
        {
            object systemInfo = null;
            try
            {
                Type type = Type.GetTypeFromProgID("Microsoft.Update.SystemInfo");
                if (type != null)
                {
                    systemInfo = Activator.CreateInstance(type);
                    object value = systemInfo.GetType().InvokeMember("RebootRequired", BindingFlags.GetProperty, null, systemInfo, null, CultureInfo.InvariantCulture);
                    if (Convert.ToBoolean(value, CultureInfo.InvariantCulture)) return true;
                }
            }
            catch { }
            finally { ReleaseCom(systemInfo); }
            using (RegistryKey componentServicing = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending"))
            {
                if (componentServicing != null) return true;
            }
            using (RegistryKey windowsUpdate = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired"))
            {
                if (windowsUpdate != null) return true;
            }
            try
            {
                using (RegistryKey key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Session Manager"))
                {
                    return key != null && key.GetValue("PendingFileRenameOperations") != null;
                }
            }
            catch { return false; }
        }

        private static List<Dictionary<string, object>> QueryServices()
        {
            List<Dictionary<string, object>> services = new List<Dictionary<string, object>>();
            try
            {
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher("SELECT Name, State, StartMode FROM Win32_Service WHERE State='Running' OR StartMode='Auto'"))
                using (ManagementObjectCollection rows = searcher.Get())
                {
                    foreach (ManagementObject row in rows)
                    {
                        if (services.Count >= 500)
                        {
                            row.Dispose();
                            break;
                        }
                        string state = Convert.ToString(row["State"], CultureInfo.InvariantCulture);
                        string name = Convert.ToString(row["Name"], CultureInfo.InvariantCulture);
                        if (string.Equals(name, AgentPaths.ServiceName, StringComparison.OrdinalIgnoreCase))
                        {
                            row.Dispose();
                            continue;
                        }
                        Dictionary<string, object> service = new Dictionary<string, object>();
                        service["name"] = name;
                        service["active"] = string.Equals(state, "Running", StringComparison.OrdinalIgnoreCase);
                        service["state"] = state;
                        services.Add(service);
                        row.Dispose();
                    }
                }
            }
            catch { }
            return services;
        }

        private static string FindIpv4Address()
        {
            try
            {
                foreach (NetworkInterface adapter in NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (adapter.OperationalStatus != OperationalStatus.Up || adapter.NetworkInterfaceType == NetworkInterfaceType.Loopback || adapter.NetworkInterfaceType == NetworkInterfaceType.Tunnel) continue;
                    foreach (UnicastIPAddressInformation address in adapter.GetIPProperties().UnicastAddresses)
                    {
                        if (address.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                        string value = address.Address.ToString();
                        if (!value.StartsWith("127.", StringComparison.Ordinal) && !value.StartsWith("169.254.", StringComparison.Ordinal)) return value;
                    }
                }
            }
            catch { }
            return string.Empty;
        }

        private static Dictionary<string, object> QueryFirst(string query)
        {
            Dictionary<string, object> result = new Dictionary<string, object>();
            try
            {
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(query))
                using (ManagementObjectCollection rows = searcher.Get())
                {
                    foreach (ManagementObject row in rows)
                    {
                        foreach (PropertyData property in row.Properties) result[property.Name] = property.Value;
                        row.Dispose();
                        break;
                    }
                }
            }
            catch { }
            return result;
        }

        private static string ReadText(Dictionary<string, object> values, string key)
        {
            object value;
            return values.TryGetValue(key, out value) && value != null ? Convert.ToString(value, CultureInfo.InvariantCulture) : string.Empty;
        }

        private static object ReadNullableNumber(Dictionary<string, object> values, string key)
        {
            double number;
            return TryReadNumber(values, key, out number) ? (object)Math.Round(number, 2) : null;
        }

        private static bool TryReadNumber(Dictionary<string, object> values, string key, out double number)
        {
            object value;
            number = 0;
            return values.TryGetValue(key, out value) && TryNumber(value, out number);
        }

        private static bool TryNumber(object value, out double number)
        {
            number = 0;
            if (value == null) return false;
            try
            {
                number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
                return !double.IsNaN(number) && !double.IsInfinity(number);
            }
            catch { return false; }
        }

        private static void ReleaseCom(object value)
        {
            if (value == null || !Marshal.IsComObject(value)) return;
            try { Marshal.FinalReleaseComObject(value); }
            catch { }
        }
    }

    internal static class AgentMaintenance
    {
        internal static string ScheduleHelper(string mode, string response)
        {
            string helperPath = Path.Combine(Path.GetTempPath(), "OmniSight.Agent." + Guid.NewGuid().ToString("N") + ".exe");
            File.Copy(Assembly.GetExecutingAssembly().Location, helperPath, true);
            ProcessStartInfo start = new ProcessStartInfo(helperPath, mode);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WorkingDirectory = Path.GetTempPath();
            Process process = Process.Start(start);
            if (process == null) throw new InvalidOperationException("maintenance helper could not be started");
            return response;
        }

        internal static int RunUpdate()
        {
            string sourcePath = Path.Combine(Path.GetTempPath(), "OmniSight.Agent." + Guid.NewGuid().ToString("N") + ".cs");
            string stagedPath = Path.Combine(Path.GetTempPath(), "OmniSight.Agent." + Guid.NewGuid().ToString("N") + ".exe");
            string backupPath = AgentPaths.ExecutablePath + ".previous";
            try
            {
                Thread.Sleep(TimeSpan.FromSeconds(8));
                AgentConfig config = AgentConfig.Load();
                AgentHttp http = new AgentHttp(config);
                string source = http.Send("GET", "/agent/OmniSight.Agent.cs", null, 45);
                if (string.IsNullOrWhiteSpace(source) || source.IndexOf("namespace OmniSight.Agent", StringComparison.Ordinal) < 0)
                    throw new InvalidOperationException("downloaded Windows service source is invalid");
                File.WriteAllText(sourcePath, source, new UTF8Encoding(false));
                CompileService(source, stagedPath);
                Version stagedVersion = AssemblyName.GetAssemblyName(stagedPath).Version;
                if (stagedVersion == null) throw new InvalidOperationException("compiled Windows service version is invalid");
                Version currentVersion = Assembly.GetExecutingAssembly().GetName().Version;
                if (currentVersion != null && stagedVersion.CompareTo(currentVersion) < 0) throw new InvalidOperationException("downloaded Windows service is older than the installed service");
                StopService(TimeSpan.FromSeconds(30));
                Directory.CreateDirectory(AgentPaths.InstallDirectory);
                if (File.Exists(backupPath)) File.Delete(backupPath);
                if (File.Exists(AgentPaths.ExecutablePath)) File.Move(AgentPaths.ExecutablePath, backupPath);
                File.Copy(stagedPath, AgentPaths.ExecutablePath, true);
                StartService(TimeSpan.FromSeconds(30));
                if (File.Exists(backupPath)) File.Delete(backupPath);
                AgentLog.Info("Windows service agent updated to " + stagedVersion);
                ScheduleSelfDelete();
                return 0;
            }
            catch (Exception error)
            {
                AgentLog.Error("Windows service update failed: " + error.Message);
                try
                {
                    if (File.Exists(backupPath))
                    {
                        if (File.Exists(AgentPaths.ExecutablePath)) File.Delete(AgentPaths.ExecutablePath);
                        File.Move(backupPath, AgentPaths.ExecutablePath);
                        StartService(TimeSpan.FromSeconds(30));
                    }
                }
                catch (Exception rollbackError)
                {
                    AgentLog.Error("Windows service rollback failed: " + rollbackError.Message);
                }
                ScheduleSelfDelete();
                return 1;
            }
            finally
            {
                TryDelete(sourcePath);
                TryDelete(stagedPath);
            }
        }

        internal static int RunUninstall()
        {
            try
            {
                Thread.Sleep(TimeSpan.FromSeconds(10));
                try { StopService(TimeSpan.FromSeconds(30)); }
                catch { }
                RunProcess(Path.Combine(Environment.SystemDirectory, "sc.exe"), "delete " + AgentPaths.ServiceName, 30);
                RunProcess(Path.Combine(Environment.SystemDirectory, "schtasks.exe"), "/Delete /TN \"OmniSightAgent\" /F", 30);
                DeleteDirectoryWithRetry(AgentPaths.InstallDirectory);
                DeleteDirectoryWithRetry(AgentPaths.DataDirectory);
                ScheduleSelfDelete();
                return 0;
            }
            catch (Exception error)
            {
                AgentLog.Error("Windows service uninstall failed: " + error.Message);
                ScheduleSelfDelete();
                return 1;
            }
        }

        private static void CompileService(string source, string outputPath)
        {
            CompilerParameters parameters = new CompilerParameters();
            parameters.GenerateExecutable = true;
            parameters.GenerateInMemory = false;
            parameters.IncludeDebugInformation = false;
            parameters.OutputAssembly = outputPath;
            parameters.CompilerOptions = "/target:winexe /platform:anycpu /optimize+";
            parameters.ReferencedAssemblies.Add("System.dll");
            parameters.ReferencedAssemblies.Add("System.Core.dll");
            parameters.ReferencedAssemblies.Add("System.Management.dll");
            parameters.ReferencedAssemblies.Add("System.ServiceProcess.dll");
            parameters.ReferencedAssemblies.Add("System.Web.Extensions.dll");
            parameters.ReferencedAssemblies.Add("Microsoft.CSharp.dll");
            using (CSharpCodeProvider provider = new CSharpCodeProvider())
            {
                CompilerResults result = provider.CompileAssemblyFromSource(parameters, source);
                if (result.Errors.HasErrors)
                {
                    StringBuilder message = new StringBuilder();
                    foreach (CompilerError error in result.Errors)
                    {
                        if (!error.IsWarning) message.Append(error.ErrorNumber).Append(": ").Append(error.ErrorText).Append("; ");
                    }
                    throw new InvalidOperationException("Windows service compilation failed: " + message);
                }
            }
        }

        private static void StopService(TimeSpan timeout)
        {
            using (ServiceController service = new ServiceController(AgentPaths.ServiceName))
            {
                service.Refresh();
                if (service.Status == ServiceControllerStatus.Stopped) return;
                if (service.Status != ServiceControllerStatus.StopPending) service.Stop();
                service.WaitForStatus(ServiceControllerStatus.Stopped, timeout);
            }
        }

        private static void StartService(TimeSpan timeout)
        {
            using (ServiceController service = new ServiceController(AgentPaths.ServiceName))
            {
                service.Refresh();
                if (service.Status != ServiceControllerStatus.Running)
                {
                    if (service.Status != ServiceControllerStatus.StartPending) service.Start();
                    service.WaitForStatus(ServiceControllerStatus.Running, timeout);
                }
            }
        }

        private static void DeleteDirectoryWithRetry(string path)
        {
            for (int attempt = 0; attempt < 10; attempt++)
            {
                try
                {
                    if (!Directory.Exists(path)) return;
                    Directory.Delete(path, true);
                    return;
                }
                catch
                {
                    Thread.Sleep(1000);
                }
            }
            if (Directory.Exists(path)) throw new IOException("could not remove " + path);
        }

        private static int RunProcess(string fileName, string arguments, int timeoutSeconds)
        {
            ProcessStartInfo start = new ProcessStartInfo(fileName, arguments);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            using (Process process = Process.Start(start))
            {
                if (process == null) return -1;
                if (!process.WaitForExit(timeoutSeconds * 1000))
                {
                    try { process.Kill(); }
                    catch { }
                    return -1;
                }
                return process.ExitCode;
            }
        }

        private static void TryDelete(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); }
            catch { }
        }

        private static void ScheduleSelfDelete()
        {
            try
            {
                string self = Assembly.GetExecutingAssembly().Location.Replace("\"", string.Empty);
                string command = "/c ping 127.0.0.1 -n 3 > nul & del /f /q \"" + self + "\"";
                ProcessStartInfo start = new ProcessStartInfo(Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe", command);
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                Process.Start(start);
            }
            catch { }
        }
    }
}
