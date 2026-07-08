const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = 3000;

// ============================
// MIDDLEWARES
// ============================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configura o Express para servir os arquivos direto da raiz do projeto
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, "public")));

// ============================
// BANCO DE DADOS (SQLite)
// ============================
const db = new sqlite3.Database("./banco.sqlite", (err) => {
    if (err) {
        console.error("Erro ao conectar banco:", err);
    } else {
        console.log("Banco de dados SQLite conectado com sucesso!");
        db.run(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nomeAdministrador TEXT,
                login TEXT UNIQUE,
                email TEXT UNIQUE,
                senha TEXT
            )
        `);
    }
});

// ============================
// ROTAS DA API
// ============================

// 1. ROTA DE REGISTRO
app.post("/api/registrar", (req, res) => {
    try {
        console.log("Dados de registro recebidos:", req.body);
        const { nomeAdministrador, login, email, senha } = req.body;

        if (!login || !senha || !email) {
            return res.status(400).json({
                sucesso: false,
                mensagem: "Campos obrigatórios ausentes (login, email ou senha)."
            });
        }

        const query = `
            INSERT INTO usuarios (nomeAdministrador, login, email, senha) 
            VALUES (?, ?, ?, ?)
        `;

        db.run(query, [nomeAdministrador, login, email, senha], function (err) {
            if (err) {
                console.error("Erro ao salvar no banco:", err.message);
                return res.status(400).json({
                    sucesso: false,
                    mensagem: "Erro ao salvar usuário. Este login ou e-mail já pode estar cadastrado."
                });
            }

            return res.status(201).json({
                sucesso: true,
                mensagem: "Conta criada com sucesso!"
            });
        });

    } catch (error) {
        console.error("Erro interno no servidor:", error);
        return res.status(500).json({ sucesso: false, mensagem: "Erro interno no servidor." });
    }
});

// 2. ROTA DE LOGIN
app.post("/api/login", (req, res) => {
    try {
        console.log("Tentativa de login recebida:", req.body);
        const identificador = req.body.login || req.body.email;
        const { senha } = req.body;

        if (!identificador || !senha) {
            return res.status(400).json({
                sucesso: false,
                mensagem: "Informe login e senha."
            });
        }

        db.get(
            `SELECT * FROM usuarios WHERE (login = ? OR email = ?) AND senha = ?`,
            [identificador, identificador, senha],
            (err, usuario) => {
                if (err) {
                    console.error("Erro no banco:", err);
                    return res.status(500).json({ sucesso: false, mensagem: "Erro no banco de dados." });
                }

                if (!usuario) {
                    return res.status(401).json({ sucesso: false, mensagem: "Usuário ou senha inválidos." });
                }

                console.log("Usuário autenticado:", usuario.login);

                return res.json({
                    sucesso: true,
                    mensagem: "Logado com sucesso!",
                    usuario: {
                        id: usuario.id,
                        nome: usuario.nomeAdministrador,
                        login: usuario.login,
                        email: usuario.email
                    }
                });
            }
        );
    } catch (error) {
        console.error("Erro interno no servidor:", error);
        return res.status(500).json({ sucesso: false, mensagem: "Erro interno no servidor." });
    }
});

// Rota para garantir a entrega das páginas caso estejam soltas na raiz
app.get("/:pagina", (req, res) => {
    res.sendFile(path.join(__dirname, req.params.pagina), (err) => {
        if (err) {
            res.sendFile(path.join(__dirname, "public", req.params.pagina), (err2) => {
                if (err2) {
                    res.status(404).send("Página não encontrada.");
                }
            });
        }
    });
});

app.listen(PORT, () => {
    console.log(`\n============= ZIBBOX BACKEND =============`);
    console.log(`Servidor rodando em: http://localhost:${PORT}`);
    console.log(`==========================================\n`);
});