package main

import (
	"encoding/json"
	"fmt"
	"archive/zip"
	"io"
	"log"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

var (
	sshClient  *ssh.Client
	sftpClient *sftp.Client
	mu         sync.Mutex
)

type ConnectRequest struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	User     string `json:"user"`
	Password string `json:"password"`
}

type FileInfo struct {
	Name    string `json:"name"`
	Size    int64  `json:"size"`
	IsDir   bool   `json:"isDir"`
	ModTime string `json:"modTime"`
}

func corsMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Disposition")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		next(w, r)
	}
}

func jsonResponse(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func jsonError(w http.ResponseWriter, status int, msg string) {
	jsonResponse(w, status, map[string]string{"error": msg})
}

func handleConnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		jsonError(w, 405, "Method not allowed")
		return
	}

	var req ConnectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, 400, "Invalid request body")
		return
	}

	if req.Port == 0 {
		req.Port = 22
	}

	mu.Lock()
	defer mu.Unlock()

	// Close existing connection if any
	if sftpClient != nil {
		sftpClient.Close()
		sftpClient = nil
	}
	if sshClient != nil {
		sshClient.Close()
		sshClient = nil
	}

	config := &ssh.ClientConfig{
		User: req.User,
		Auth: []ssh.AuthMethod{
			ssh.Password(req.Password),
		},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         10 * time.Second,
	}

	addr := fmt.Sprintf("%s:%d", req.Host, req.Port)
	var err error
	sshClient, err = ssh.Dial("tcp", addr, config)
	if err != nil {
		jsonError(w, 500, fmt.Sprintf("SSH connection failed: %v", err))
		return
	}

	sftpClient, err = sftp.NewClient(sshClient)
	if err != nil {
		sshClient.Close()
		sshClient = nil
		jsonError(w, 500, fmt.Sprintf("SFTP session failed: %v", err))
		return
	}

	jsonResponse(w, 200, map[string]string{"status": "connected"})
}

func handleFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		jsonError(w, 405, "Method not allowed")
		return
	}

	mu.Lock()
	client := sftpClient
	mu.Unlock()

	if client == nil {
		jsonError(w, 400, "Not connected")
		return
	}

	dirPath := r.URL.Query().Get("path")
	if dirPath == "" {
		dirPath = "."
	}

	entries, err := client.ReadDir(dirPath)
	if err != nil {
		jsonError(w, 500, fmt.Sprintf("Failed to list files: %v", err))
		return
	}

	files := make([]FileInfo, 0, len(entries))
	for _, entry := range entries {
		files = append(files, FileInfo{
			Name:    entry.Name(),
			Size:    entry.Size(),
			IsDir:   entry.IsDir(),
			ModTime: entry.ModTime().Format(time.RFC3339),
		})
	}

	jsonResponse(w, 200, files)
}

func handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		jsonError(w, 405, "Method not allowed")
		return
	}

	mu.Lock()
	client := sftpClient
	mu.Unlock()

	if client == nil {
		jsonError(w, 400, "Not connected")
		return
	}

	if err := r.ParseMultipartForm(100 << 20); err != nil { // 100MB max
		jsonError(w, 400, fmt.Sprintf("Failed to parse form: %v", err))
		return
	}

	destPath := r.FormValue("path")
	if destPath == "" {
		destPath = "."
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		jsonError(w, 400, fmt.Sprintf("Failed to get file: %v", err))
		return
	}
	defer file.Close()

	// Support subfolder from "subpath" form field (for folder uploads)
	subPath := r.FormValue("subpath")
	remotePath := ""
	if subPath != "" {
		// Normalize path separators
		subPath = strings.ReplaceAll(subPath, "\\", "/")
		// Create all intermediate directories one by one
		dir := path.Join(destPath, path.Dir(subPath))
		parts := strings.Split(dir, "/")
		current := ""
		for _, p := range parts {
			if p == "" {
				current = "/"
				continue
			}
			if current == "" {
				current = p
			} else {
				current = current + "/" + p
			}
			client.Mkdir(current) // ignore error if exists
		}
		remotePath = path.Join(destPath, subPath)
	} else {
		remotePath = path.Join(destPath, header.Filename)
	}
	remoteFile, err := client.Create(remotePath)
	if err != nil {
		jsonError(w, 500, fmt.Sprintf("Failed to create remote file: %v", err))
		return
	}
	defer remoteFile.Close()

	written, err := io.Copy(remoteFile, file)
	if err != nil {
		jsonError(w, 500, fmt.Sprintf("Failed to write file: %v", err))
		return
	}

	jsonResponse(w, 200, map[string]interface{}{
		"status":   "uploaded",
		"filename": header.Filename,
		"size":     written,
	})
}

func handleDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != "DELETE" {
		jsonError(w, 405, "Method not allowed")
		return
	}

	mu.Lock()
	client := sftpClient
	mu.Unlock()

	if client == nil {
		jsonError(w, 400, "Not connected")
		return
	}

	filePath := r.URL.Query().Get("path")
	if filePath == "" {
		jsonError(w, 400, "Path is required")
		return
	}

	// Try simple remove first, if fails try recursive
	if err := client.Remove(filePath); err != nil {
		// Check if it's a directory
		stat, statErr := client.Stat(filePath)
		if statErr != nil {
			jsonError(w, 500, fmt.Sprintf("Failed to delete: %v", err))
			return
		}
		if stat.IsDir() {
			if rmErr := removeDir(client, filePath); rmErr != nil {
				jsonError(w, 500, fmt.Sprintf("Failed to delete directory: %v", rmErr))
				return
			}
		} else {
			jsonError(w, 500, fmt.Sprintf("Failed to delete: %v", err))
			return
		}
	}

	jsonResponse(w, 200, map[string]string{"status": "deleted"})
}

func handleRename(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		jsonError(w, 405, "Method not allowed")
		return
	}

	mu.Lock()
	client := sftpClient
	mu.Unlock()

	if client == nil {
		jsonError(w, 400, "Not connected")
		return
	}

	var req struct {
		OldPath string `json:"oldPath"`
		NewPath string `json:"newPath"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, 400, "Invalid request")
		return
	}

	if err := client.Rename(req.OldPath, req.NewPath); err != nil {
		jsonError(w, 500, fmt.Sprintf("Rename failed: %v", err))
		return
	}

	jsonResponse(w, 200, map[string]string{"status": "renamed"})
}

func handleMkdir(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		jsonError(w, 405, "Method not allowed")
		return
	}

	mu.Lock()
	client := sftpClient
	mu.Unlock()

	if client == nil {
		jsonError(w, 400, "Not connected")
		return
	}

	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, 400, "Invalid request")
		return
	}

	if err := client.Mkdir(req.Path); err != nil {
		jsonError(w, 500, fmt.Sprintf("Mkdir failed: %v", err))
		return
	}

	jsonResponse(w, 200, map[string]string{"status": "created"})
}

func handleDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		jsonError(w, 405, "Method not allowed")
		return
	}

	mu.Lock()
	client := sftpClient
	mu.Unlock()

	if client == nil {
		jsonError(w, 400, "Not connected")
		return
	}

	filePath := r.URL.Query().Get("path")
	if filePath == "" {
		jsonError(w, 400, "Path is required")
		return
	}

	file, err := client.Open(filePath)
	if err != nil {
		jsonError(w, 500, fmt.Sprintf("Failed to open file: %v", err))
		return
	}
	defer file.Close()

	stat, err := file.Stat()
	if err != nil {
		jsonError(w, 500, fmt.Sprintf("Failed to stat file: %v", err))
		return
	}

	fileName := path.Base(filePath)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", fileName))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", stat.Size()))

	io.Copy(w, file)
}

type DiskInfo struct {
	Filesystem string `json:"filesystem"`
	Total      int64  `json:"total"`
	Used       int64  `json:"used"`
	Available  int64  `json:"available"`
	UsePercent string `json:"usePercent"`
	MountedOn  string `json:"mountedOn"`
}

func handleDiskInfo(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	client := sshClient
	mu.Unlock()

	if client == nil {
		jsonError(w, 400, "Not connected")
		return
	}

	session, err := client.NewSession()
	if err != nil {
		jsonError(w, 500, fmt.Sprintf("SSH session failed: %v", err))
		return
	}
	defer session.Close()

	output, err := session.Output("df -B1 2>/dev/null || df -k")
	if err != nil {
		jsonError(w, 500, fmt.Sprintf("df command failed: %v", err))
		return
	}

	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	disks := make([]DiskInfo, 0)

	for _, line := range lines[1:] { // skip header
		fields := strings.Fields(line)
		if len(fields) < 6 {
			continue
		}
		// Skip tmpfs, devtmpfs etc
		fs := fields[0]
		if strings.HasPrefix(fs, "tmpfs") || strings.HasPrefix(fs, "devtmpfs") || strings.HasPrefix(fs, "udev") || fs == "none" {
			continue
		}

		total, _ := strconv.ParseInt(fields[1], 10, 64)
		used, _ := strconv.ParseInt(fields[2], 10, 64)
		avail, _ := strconv.ParseInt(fields[3], 10, 64)

		disks = append(disks, DiskInfo{
			Filesystem: fs,
			Total:      total,
			Used:       used,
			Available:  avail,
			UsePercent: fields[4],
			MountedOn:  fields[5],
		})
	}

	jsonResponse(w, 200, disks)
}

func runSSHCommand(cmd string) (string, error) {
	mu.Lock()
	client := sshClient
	mu.Unlock()

	if client == nil {
		return "", fmt.Errorf("not connected")
	}

	session, err := client.NewSession()
	if err != nil {
		return "", err
	}
	defer session.Close()

	output, err := session.Output(cmd)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(output)), nil
}

func handleSysInfo(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	client := sshClient
	mu.Unlock()

	if client == nil {
		jsonError(w, 400, "Not connected")
		return
	}

	info := make(map[string]string)

	// Hostname
	if v, err := runSSHCommand("hostname"); err == nil {
		info["hostname"] = v
	}

	// OS
	if v, err := runSSHCommand("cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d'\"' -f2"); err == nil && v != "" {
		info["os"] = v
	} else if v, err := runSSHCommand("uname -o"); err == nil {
		info["os"] = v
	}

	// Kernel
	if v, err := runSSHCommand("uname -r"); err == nil {
		info["kernel"] = v
	}

	// Architecture
	if v, err := runSSHCommand("uname -m"); err == nil {
		info["arch"] = v
	}

	// Uptime
	if v, err := runSSHCommand("uptime -p 2>/dev/null || uptime"); err == nil {
		info["uptime"] = v
	}

	// CPU info
	if v, err := runSSHCommand("grep 'model name' /proc/cpuinfo | head -1 | cut -d':' -f2"); err == nil && v != "" {
		info["cpu"] = strings.TrimSpace(v)
	}

	// CPU cores
	if v, err := runSSHCommand("nproc"); err == nil {
		info["cores"] = v
	}

	// RAM total/used/free
	if v, err := runSSHCommand("free -b | grep Mem"); err == nil {
		fields := strings.Fields(v)
		if len(fields) >= 4 {
			info["ram_total"] = fields[1]
			info["ram_used"] = fields[2]
			info["ram_free"] = fields[3]
		}
	}

	// Load average
	if v, err := runSSHCommand("cat /proc/loadavg | cut -d' ' -f1-3"); err == nil {
		info["load"] = v
	}

	// IP
	if v, err := runSSHCommand("hostname -I 2>/dev/null | awk '{print $1}'"); err == nil && v != "" {
		info["ip"] = v
	}

	jsonResponse(w, 200, info)
}

func handleExists(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	client := sftpClient
	mu.Unlock()

	if client == nil {
		jsonError(w, 400, "Not connected")
		return
	}

	filePath := r.URL.Query().Get("path")
	_, err := client.Stat(filePath)
	jsonResponse(w, 200, map[string]bool{"exists": err == nil})
}

func removeDir(client *sftp.Client, dirPath string) error {
	entries, err := client.ReadDir(dirPath)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		fullPath := dirPath + "/" + entry.Name()
		if entry.IsDir() {
			if err := removeDir(client, fullPath); err != nil {
				return err
			}
		} else {
			if err := client.Remove(fullPath); err != nil {
				return err
			}
		}
	}
	return client.RemoveDirectory(dirPath)
}

var skipDirs = map[string]bool{
	"node_modules": true, ".git": true, "__pycache__": true,
	".cache": true, "vendor": true, ".next": true, "dist": true,
}

func handleDownloadDir(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		jsonError(w, 405, "Method not allowed")
		return
	}

	mu.Lock()
	client := sftpClient
	mu.Unlock()

	if client == nil {
		jsonError(w, 400, "Not connected")
		return
	}

	dirPath := r.URL.Query().Get("path")
	if dirPath == "" {
		jsonError(w, 400, "Path is required")
		return
	}

	dirName := path.Base(dirPath)

	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s.zip\"", dirName))
	w.Header().Set("Content-Type", "application/zip")

	zw := zip.NewWriter(w)
	defer zw.Close()

	// Get exclude list from query param
	excludeParam := r.URL.Query().Get("exclude")
	extraSkip := map[string]bool{}
	if excludeParam != "" {
		for _, s := range strings.Split(excludeParam, ",") {
			extraSkip[strings.TrimSpace(s)] = true
		}
	}

	var walkDir func(string, string) error
	walkDir = func(remotePath, zipPrefix string) error {
		entries, err := client.ReadDir(remotePath)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			// Skip heavy/unnecessary directories
			if entry.IsDir() && (skipDirs[entry.Name()] || extraSkip[entry.Name()]) {
				continue
			}

			fullPath := remotePath + "/" + entry.Name()
			zipPath := zipPrefix + "/" + entry.Name()

			if entry.IsDir() {
				_, err := zw.Create(zipPath + "/")
				if err != nil {
					return err
				}
				if err := walkDir(fullPath, zipPath); err != nil {
					return err
				}
			} else {
				header, err := zip.FileInfoHeader(entry)
				if err != nil {
					return err
				}
				header.Name = zipPath
				header.Method = zip.Deflate

				writer, err := zw.CreateHeader(header)
				if err != nil {
					return err
				}

				file, err := client.Open(fullPath)
				if err != nil {
					return err
				}
				io.Copy(writer, file)
				file.Close()
			}
		}
		return nil
	}

	if err := walkDir(dirPath, dirName); err != nil {
		log.Printf("Zip walk error: %v", err)
	}
}

func handleReadFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		jsonError(w, 405, "Method not allowed")
		return
	}

	mu.Lock()
	client := sftpClient
	mu.Unlock()

	if client == nil {
		jsonError(w, 400, "Not connected")
		return
	}

	filePath := r.URL.Query().Get("path")
	if filePath == "" {
		jsonError(w, 400, "Path is required")
		return
	}

	file, err := client.Open(filePath)
	if err != nil {
		jsonError(w, 500, fmt.Sprintf("Failed to open file: %v", err))
		return
	}
	defer file.Close()

	stat, err := file.Stat()
	if err != nil {
		jsonError(w, 500, fmt.Sprintf("Failed to stat file: %v", err))
		return
	}

	// Limit to 5MB for text editing
	if stat.Size() > 5*1024*1024 {
		jsonError(w, 400, "File too large to edit (max 5MB)")
		return
	}

	data, err := io.ReadAll(file)
	if err != nil {
		jsonError(w, 500, fmt.Sprintf("Failed to read file: %v", err))
		return
	}

	jsonResponse(w, 200, map[string]interface{}{
		"content": string(data),
		"size":    stat.Size(),
	})
}

func handleWriteFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		jsonError(w, 405, "Method not allowed")
		return
	}

	mu.Lock()
	client := sftpClient
	mu.Unlock()

	if client == nil {
		jsonError(w, 400, "Not connected")
		return
	}

	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, 400, "Invalid request")
		return
	}

	file, err := client.Create(req.Path)
	if err != nil {
		jsonError(w, 500, fmt.Sprintf("Failed to create file: %v", err))
		return
	}
	defer file.Close()

	written, err := file.Write([]byte(req.Content))
	if err != nil {
		jsonError(w, 500, fmt.Sprintf("Failed to write file: %v", err))
		return
	}

	jsonResponse(w, 200, map[string]interface{}{
		"status": "saved",
		"size":   written,
	})
}

func handleExec(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		jsonError(w, 405, "Method not allowed")
		return
	}

	mu.Lock()
	client := sshClient
	mu.Unlock()

	if client == nil {
		jsonError(w, 400, "Not connected")
		return
	}

	var req struct {
		Command string `json:"command"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, 400, "Invalid request")
		return
	}

	session, err := client.NewSession()
	if err != nil {
		jsonError(w, 500, fmt.Sprintf("Session failed: %v", err))
		return
	}
	defer session.Close()

	output, err := session.CombinedOutput(req.Command)
	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*ssh.ExitError); ok {
			exitCode = exitErr.ExitStatus()
		} else {
			jsonError(w, 500, fmt.Sprintf("Exec failed: %v", err))
			return
		}
	}

	jsonResponse(w, 200, map[string]interface{}{
		"output":   string(output),
		"exitCode": exitCode,
	})
}

func handleDisconnect(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	defer mu.Unlock()

	if sftpClient != nil {
		sftpClient.Close()
		sftpClient = nil
	}
	if sshClient != nil {
		sshClient.Close()
		sshClient = nil
	}

	jsonResponse(w, 200, map[string]string{"status": "disconnected"})
}

func main() {
	http.HandleFunc("/connect", corsMiddleware(handleConnect))
	http.HandleFunc("/files", corsMiddleware(handleFiles))
	http.HandleFunc("/upload", corsMiddleware(handleUpload))
	http.HandleFunc("/delete", corsMiddleware(handleDelete))
	http.HandleFunc("/rename", corsMiddleware(handleRename))
	http.HandleFunc("/mkdir", corsMiddleware(handleMkdir))
	http.HandleFunc("/download", corsMiddleware(handleDownload))
	http.HandleFunc("/diskinfo", corsMiddleware(handleDiskInfo))
	http.HandleFunc("/sysinfo", corsMiddleware(handleSysInfo))
	http.HandleFunc("/exists", corsMiddleware(handleExists))
	http.HandleFunc("/downloaddir", corsMiddleware(handleDownloadDir))
	http.HandleFunc("/readfile", corsMiddleware(handleReadFile))
	http.HandleFunc("/writefile", corsMiddleware(handleWriteFile))
	http.HandleFunc("/exec", corsMiddleware(handleExec))
	http.HandleFunc("/disconnect", corsMiddleware(handleDisconnect))

	log.Println("Backend running on http://localhost:8899")
	log.Fatal(http.ListenAndServe(":8899", nil))
}
