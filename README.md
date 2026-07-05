# MariaDB & MySQL Database Client for VS Code

A high-performance **Database Client** extension for VS Code designed specifically for **MariaDB** and **MySQL**. Manage your databases, run queries, and edit data seamlessly without leaving your editor.

---

## ⚡ Key Features

- **Blazing Fast Performance:** Lightweight and optimized for quick database interactions.
- **Intelligent SQL Autocomplete:** Smart suggestions for schemas, tables, and field names as you type.
- **Inline Data Editing:** View and update your database records directly within the editor.
- **Recent Files History:** Quickly reopen and access your recently used SQL scripts.
- **Connection Color Coding:** Assign distinct colors to different database connections to avoid running queries on the wrong server.
- **Query Killer:** Instantly abort long-running or stuck queries with the "Kill Query" feature.
- **SQL Code Formatting:** Keep your SQL scripts clean and organized automatically.

---

## ⚙️ How to Install & Configure

The extension securely reads your database connections using standard MariaDB option files (`.cnf`).

### Step 1: Create configuration directory
In your user home directory, create a folder named `.db_configs`:
- **Linux/macOS:** `~/.db_configs/`
- **Windows:** `C:\Users\<YourUsername>\.db_configs\`

### Step 2: Add your database settings
Place your connection configuration files inside the `.db_configs` directory. You can create multiple files for different servers. Here are examples of how to configure them:

#### Example 1: Local Socket Connection (`local.cnf`)
```ini
[client]
socket = /run/mysqld/mysqld.sock
user = root
password = root
database = 
skip-ssl = true
reconnect = false
compress = false
```

#### Example 2: Reusing/Inheriting Settings (`local-xxx.cnf`)
```ini
!include ~/.db_configs/local.cnf

[client]
database = xxx
```

#### Example 3: External Remote Server (`external.cnf`)
```ini
[client]
host = <host>
user = <user>
password = <password>
database = <name_of_database>
skip-ssl = true
reconnect = true
compress = true

[mysqld]
tcp_keepalive_time = 60
```

> 💡 Need more details on configuration? Check the official [MariaDB Option Files Documentation](https://mariadb.com/docs/server/server-management/install-and-upgrade-mariadb/configuring-mariadb/configuring-mariadb-with-option-files).

---

## 🚀 How to Use

1. Open or create any file with a `.sql` extension.
2. Type your database query.
3. Press **`Ctrl + Enter`** to execute the SQL query immediately.

![Database Client Execution](images/screenshot1.png)

---

## 🐧 OS Specific Notes

### Linux Users
To see colors correctly when assigning a color to a specific DB connection, you should install the Noto Color Emoji font.
* **Debian / Ubuntu:**
  ```bash
  sudo apt install fonts-noto-color-emoji
  ```

### Platform Support
This extension has been fully tested and verified on both **Linux** and **Windows** environments.

---

## ☕ Support the Project

[![ko-fi](images/ko-fi.png)](https://ko-fi.com/w77w77)
