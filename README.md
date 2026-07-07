# MariaDB & MySQL Database Client for VS Code

Fast **MariaDB & MySQL database client** for **Visual Studio Code** with intelligent SQL autocomplete, schema browsing, query execution, inline data editing and SQL formatting.

---

## Features

- ⚡ Fast and lightweight DB client
- 🧠 SQL IntelliSense, autocomplete and snippets (`Ctrl+Space`)
- 📂 Schema, table and column suggestions (`Ctrl+Space`)
- 🔧 MariaDB & MySQL function suggestions (`Ctrl+Space`)
- ▶️ Execute current query (`Ctrl+Enter`)
- ▶️ Execute entire SQL file (`Alt+X`)
- ✏️ Inline table data editing
- 🎨 SQL formatter (`Ctrl+Shift+F`)
- 📋 Recent SQL files (`F3`)
- 🎨 Connection color indicators
- 🛑 Kill long-running queries

---

## ⚙️ How to Install & Configure

The extension securely reads your database connections using standard MariaDB option files (`.cnf`).

### Step 1: Create configuration directory
In your user home directory, create a folder named `.db_configs`:
- **Linux/macOS:** `~/.db_configs/`
- **Windows:** `C:\Users\<YourUsername>\.db_configs\`

### Step 2: Add your database settings
Place one or more connection configuration files in the `.db_configs` directory. You can create multiple files for different servers. Here are examples of how to configure them:

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

#### Run SQL

1. Open or create any file with a `.sql` extension.
2. Type your database query.
3. Press **`Ctrl + Enter`** to execute the current SQL query.

#### Snippets

1. Place the cursor at the beginning of a new line.
2. Press `Ctrl + Space`.
3. Select the SQL snippet you want to insert.

![Database Client Execution](images/screenshot2.png)

#### Change DB connection and DB color

![Database Client Execution](images/screenshot1.png)

---

## 🐧 OS Support

#### Supported Platforms
✅ Linux

✅ Windows

#### Linux Notes
To see colors correctly when assigning a color to a database connection, install the Noto Color Emoji font.
* **Debian / Ubuntu:**
  ```bash
  sudo apt install fonts-noto-color-emoji
  ```

---

## ☕ Support the Project

[![ko-fi](images/ko-fi.png)](https://ko-fi.com/w77w77)
