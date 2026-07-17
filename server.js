const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const path = require("path");

const app = express();
// Usa a porta fornecida pelo ambiente (Render, etc.) ou 3000 para desenvolvimento local
const PORT = process.env.PORT || 3000;

// ============================
// MIDDLEWARES
// ============================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configura o Express para servir os arquivos estáticos
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

        // Criando as tabelas do sistema
        db.run(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nomeAdministrador TEXT,
                login TEXT UNIQUE,
                email TEXT UNIQUE,
                senha TEXT
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS condominios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nome TEXT,
                documento TEXT,
                cep TEXT,
                cidade TEXT,
                endereco TEXT,
                bairro TEXT,
                tipo TEXT,
                usuario_id INTEGER,
                FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS moradores (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                usuario_id INTEGER,
                unidade TEXT,
                nome TEXT,
                foto TEXT,
                FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS encomendas (
                codigo INTEGER PRIMARY KEY AUTOINCREMENT,
                usuario_id INTEGER,
                unidade TEXT,
                nome TEXT,
                transp TEXT,
                tipo TEXT,
                grupo INTEGER DEFAULT 1,
                codigoRastreio TEXT,
                entregadorNome TEXT,
                entregadorDoc TEXT,
                observacao TEXT,
                foto TEXT,
                escaninho TEXT,
                status TEXT DEFAULT 'recebido',
                privada INTEGER DEFAULT 0,
                ts TEXT,
                por TEXT,
                FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS timeline (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                usuario_id INTEGER,
                tipo TEXT,
                unidade TEXT,
                texto TEXT,
                ts TEXT,
                por TEXT,
                FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
            )
        `);
    }
});

// ============================
// ROTAS DA API
// ============================

// 1. ROTA DE REGISTRO SIMPLES
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

// 2. ROTA DE CADASTRO COMPLETO (condomínio + administrador)
app.post("/api/cadastro", (req, res) => {
    try {
        console.log("Dados de cadastro recebidos:", req.body);

        const {
            nomeCondominio,
            documento,
            cep,
            cidade,
            endereco,
            bairro,
            tipo,
            email,
            senha
        } = req.body;

        if (!nomeCondominio || !documento || !cep || !cidade || !endereco || !bairro || !tipo || !email || !senha) {
            return res.status(400).json({
                sucesso: false,
                mensagem: "Preencha todos os campos obrigatórios."
            });
        }

        const login = email;
        const nomeAdministrador = nomeCondominio;

        const queryUsuario = `
            INSERT INTO usuarios (nomeAdministrador, login, email, senha)
            VALUES (?, ?, ?, ?)
        `;

        db.run(queryUsuario, [nomeAdministrador, login, email, senha], function (err) {
            if (err) {
                console.error("Erro ao criar usuário:", err.message);
                return res.status(400).json({
                    sucesso: false,
                    mensagem: "Não foi possível criar a conta. Este e-mail já pode estar cadastrado."
                });
            }

            const usuarioId = this.lastID;

            const queryCondominio = `
                INSERT INTO condominios (nome, documento, cep, cidade, endereco, bairro, tipo, usuario_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `;

            db.run(
                queryCondominio,
                [nomeCondominio, documento, cep, cidade, endereco, bairro, tipo, usuarioId],
                function (err2) {
                    if (err2) {
                        console.error("Erro ao salvar condomínio:", err2.message);
                        return res.status(500).json({
                            sucesso: false,
                            mensagem: "Conta criada, mas houve um erro ao salvar os dados do condomínio."
                        });
                    }

                    return res.status(201).json({
                        sucesso: true,
                        mensagem: "Cadastro realizado com sucesso!",
                        usuario: {
                            id: usuarioId,
                            nome: nomeAdministrador,
                            login: login,
                            email: email
                        }
                    });
                }
            );
        });

    } catch (error) {
        console.error("Erro interno no servidor:", error);
        return res.status(500).json({ sucesso: false, mensagem: "Erro interno no servidor." });
    }
});

// 3. ROTA DE LOGIN
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
                    return res.status(500).json({ sucesso: false, message: "Erro no banco de dados." });
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

// ============================
// ROTAS: MORADORES
// ============================

app.get("/api/moradores/:usuario_id", (req, res) => {
    const { usuario_id } = req.params;
    db.all(
        `SELECT * FROM moradores WHERE usuario_id = ? ORDER BY id ASC`,
        [usuario_id],
        (err, rows) => {
            if (err) {
                console.error("Erro ao listar moradores:", err.message);
                return res.status(500).json({ sucesso: false, mensagem: "Erro ao buscar moradores." });
            }
            return res.json({ sucesso: true, moradores: rows });
        }
    );
});

app.post("/api/moradores", (req, res) => {
    const { usuario_id, unidade, nome, foto } = req.body;

    if (!unidade || !nome) {
        return res.status(400).json({ sucesso: false, mensagem: "Preencha unidade e nome do morador." });
    }

    const query = `INSERT INTO moradores (usuario_id, unidade, nome, foto) VALUES (?, ?, ?, ?)`;
    db.run(query, [usuario_id || null, unidade, nome, foto || null], function (err) {
        if (err) {
            console.error("Erro ao cadastrar morador:", err.message);
            return res.status(500).json({ sucesso: false, mensagem: "Erro ao salvar morador." });
        }
        return res.status(201).json({ sucesso: true, id: this.lastID });
    });
});

// ============================
// ROTAS: ENCOMENDAS
// ============================

app.get("/api/encomendas/:usuario_id", (req, res) => {
    const { usuario_id } = req.params;
    db.all(
        `SELECT * FROM encomendas WHERE usuario_id = ? ORDER BY codigo ASC`,
        [usuario_id],
        (err, rows) => {
            if (err) {
                console.error("Erro ao listar encomendas:", err.message);
                return res.status(500).json({ sucesso: false, mensagem: "Erro ao buscar encomendas." });
            }
            const encomendas = rows.map((e) => ({ ...e, privada: !!e.privada }));
            return res.json({ sucesso: true, encomendas });
        }
    );
});

app.post("/api/encomendas", (req, res) => {
    const {
        usuario_id, unidade, nome, transp, tipo, grupo,
        codigoRastreio, entregadorNome, entregadorDoc, observacao,
        foto, escaninho, status, privada, ts, por
    } = req.body;

    if (!unidade || !nome) {
        return res.status(400).json({ sucesso: false, mensagem: "Preencha unidade e destinatário." });
    }

    const query = `
        INSERT INTO encomendas (
            usuario_id, unidade, nome, transp, tipo, grupo, codigoRastreio,
            entregadorNome, entregadorDoc, observacao, foto, escaninho, status, privada, ts, por
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(
        query,
        [
            usuario_id || null, unidade, nome, transp || "Transportadora", tipo || "Pacote",
            grupo || 1, codigoRastreio || "", entregadorNome || "", entregadorDoc || "",
            observacao || "", foto || null, escaninho || null, status || "recebido",
            privada ? 1 : 0, ts || null, por || null
        ],
        function (err) {
            if (err) {
                console.error("Erro ao registrar encomenda:", err.message);
                return res.status(500).json({ sucesso: false, mensagem: "Erro ao salvar encomenda." });
            }
            return res.status(201).json({ sucesso: true, codigo: this.lastID });
        }
    );
});

app.patch("/api/encomendas/:codigo", (req, res) => {
    const { codigo } = req.params;
    const { status, escaninho } = req.body;

    const campos = [];
    const valores = [];
    if (status !== undefined) { campos.push("status = ?"); valores.push(status); }
    if (escaninho !== undefined) { campos.push("escaninho = ?"); valores.push(escaninho); }

    if (!campos.length) {
        return res.status(400).json({ sucesso: false, mensagem: "Nada para atualizar." });
    }

    valores.push(codigo);
    const query = `UPDATE encomendas SET ${campos.join(", ")} WHERE codigo = ?`;

    db.run(query, valores, function (err) {
        if (err) {
            console.error("Erro ao atualizar encomenda:", err.message);
            return res.status(500).json({ sucesso: false, mensagem: "Erro ao atualizar encomenda." });
        }
        if (this.changes === 0) {
            return res.status(404).json({ sucesso: false, mensagem: "Encomenda não encontrada." });
        }
        return res.json({ sucesso: true });
    });
});

// ============================
// ROTAS: TIMELINE
// ============================

app.get("/api/timeline/:usuario_id", (req, res) => {
    const { usuario_id } = req.params;
    db.all(
        `SELECT * FROM timeline WHERE usuario_id = ? ORDER BY id DESC LIMIT 50`,
        [usuario_id],
        (err, rows) => {
            if (err) {
                console.error("Erro ao listar timeline:", err.message);
                return res.status(500).json({ sucesso: false, mensagem: "Erro ao buscar histórico." });
            }
            return res.json({ sucesso: true, timeline: rows });
        }
    );
});

app.post("/api/timeline", (req, res) => {
    const { usuario_id, tipo, unidade, texto, ts, por } = req.body;

    const query = `INSERT INTO timeline (usuario_id, tipo, unidade, texto, ts, por) VALUES (?, ?, ?, ?, ?, ?)`;
    db.run(query, [usuario_id || null, tipo, unidade, texto, ts || null, por || null], function (err) {
        if (err) {
            console.error("Erro ao salvar timeline:", err.message);
            return res.status(500).json({ sucesso: false, mensagem: "Erro ao salvar histórico." });
        }
        return res.status(201).json({ sucesso: true, id: this.lastID });
    });
});

// ============================
// TRATAMENTO DE ROTAS /API NÃO ENCONTRADAS (GARANTE RETORNO JSON)
// ============================
// Se bater em qualquer rota começando com "/api" que não foi definida acima, retorna JSON amigável de erro
app.use("/api", (req, res) => {
    res.status(404).json({
        sucesso: false,
        mensagem: `Rota de API não encontrada: ${req.method} ${req.originalUrl}`
    });
});

// ============================
// ROTAS DE NAVEGAÇÃO / FRONTEND
// ============================

app.get("/", (req, res) => {
    res.redirect("/login.html");
});

app.get("/:pagina", (req, res) => {
    // Garante que tentativas de requisições de API que cheguem aqui não tentem carregar um HTML
    if (req.params.pagina.startsWith("api")) {
        return res.status(404).json({
            sucesso: false,
            mensagem: "Recurso de API não encontrado neste servidor."
        });
    }

    res.sendFile(path.join(__dirname, req.params.pagina), (err) => {
        if (err) {
            res.sendFile(path.join(__dirname, "public", req.params.pagina), (err2) => {
                if (err2) {
                    res.status(404).send("<h1>Erro 404 - Página não encontrada.</h1>");
                }
            });
        }
    });
});

// ============================
// INICIALIZAÇÃO DO SERVIDOR
// ============================

app.listen(PORT, () => {
    console.log(`\n============= ZIBBOX BACKEND =============`);
    console.log(`Servidor rodando na porta: ${PORT}`);
    console.log(`==========================================\n`);
});
