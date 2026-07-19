const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = 3000;

// ============================
// MIDDLEWARES
// ============================
app.use(cors());
app.use(express.json({ limit: "15mb" })); // limite maior por causa das fotos em base64
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

// Configura o Express para servir os arquivos direto da raiz do projeto
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, "public")));

// ============================
// BANCO DE DADOS (SQLite via better-sqlite3)
// ============================
// better-sqlite3 é síncrono: cada instrução roda e termina na hora, sem
// callbacks e sem risco de uma rota ser chamada antes das tabelas existirem
// (que era um risco real com o driver "sqlite3" assíncrono usado antes).
let db;
try {
    db = new Database(path.join(__dirname, "banco.sqlite"));
    db.pragma("journal_mode = WAL");
    console.log("Banco de dados SQLite conectado com sucesso!");
} catch (err) {
    console.error("ERRO FATAL ao conectar no banco de dados:", err);
    process.exit(1);
}

db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nomeAdministrador TEXT,
        login TEXT UNIQUE,
        email TEXT UNIQUE,
        senha TEXT
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS condominios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT,
        documento TEXT,
        cep TEXT,
        cidade TEXT,
        endereco TEXT,
        bairro TEXT,
        tipo TEXT,
        telefone TEXT,
        nomeResponsavel TEXT,
        usuario_id INTEGER,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    )
`);

// Migração leve: bancos criados antes dos campos "telefone" e
// "nomeResponsavel" (tela Cadastrar condomínio) não têm essas colunas
// ainda — adiciona agora. Ignora "duplicate column" se já existirem.
try { db.exec(`ALTER TABLE condominios ADD COLUMN telefone TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE condominios ADD COLUMN nomeResponsavel TEXT`); } catch (e) {}
// Migração leve: latitude/longitude do condomínio, preenchidas automaticamente
// a partir do endereço (CEP + rua) na tela "Cadastrar condomínio" do painel —
// usadas para mostrar a planta/mapa do local salvo junto do cadastro.
try { db.exec(`ALTER TABLE condominios ADD COLUMN latitude TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE condominios ADD COLUMN longitude TEXT`); } catch (e) {}

db.exec(`
    CREATE TABLE IF NOT EXISTS moradores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER,
        unidade TEXT,
        nome TEXT,
        foto TEXT,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    )
`);

db.exec(`
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
        retiradoPor TEXT,
        retiradoDoc TEXT,
        assinaturaFuncionario TEXT,
        assinaturaRetirada TEXT,
        retiradoTs TEXT,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    )
`);

// Migração leve: bancos criados antes da tela de Retirada com assinatura
// não têm essas colunas ainda — adiciona agora (ignora "duplicate column"
// se o banco já for novo o suficiente para já ter sido criado com elas).
try { db.exec(`ALTER TABLE encomendas ADD COLUMN retiradoPor TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE encomendas ADD COLUMN retiradoDoc TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE encomendas ADD COLUMN assinaturaFuncionario TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE encomendas ADD COLUMN assinaturaRetirada TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE encomendas ADD COLUMN retiradoTs TEXT`); } catch (e) {}
// Nome de quem está autorizado a retirar a encomenda, definido na hora de
// "separar" o pacote na portaria — usado na tela "Encomendas separadas" do
// portal do funcionário para mostrar quem vai buscar cada uma.
try { db.exec(`ALTER TABLE encomendas ADD COLUMN responsavelRetirada TEXT`); } catch (e) {}

db.exec(`
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

// Funcionários (equipe da portaria) de cada administrador
db.exec(`
    CREATE TABLE IF NOT EXISTS funcionarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER,
        nome TEXT,
        cargo TEXT DEFAULT 'Responsável pelo recebimento',
        foto TEXT,
        documento TEXT,
        senha TEXT,
        online INTEGER DEFAULT 0,
        criado_em TEXT,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    )
`);

// Migração leve: se o banco já existia antes das colunas "documento" e
// "senha" serem criadas (portal do funcionário), adiciona elas agora.
// O ALTER falha com "duplicate column" se já existir, e isso é ignorado
// de propósito — é só pra não quebrar bancos criados antes dessa versão.
try { db.exec(`ALTER TABLE funcionarios ADD COLUMN documento TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE funcionarios ADD COLUMN senha TEXT`); } catch (e) {}

// Convites por link — usados para o próprio morador se cadastrar preenchendo
// os dados dele, em vez do admin ter que digitar tudo manualmente.
db.exec(`
    CREATE TABLE IF NOT EXISTS convites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER,
        tipo TEXT DEFAULT 'morador',
        contato TEXT,
        unidade TEXT,
        token TEXT UNIQUE,
        usado INTEGER DEFAULT 0,
        criado_em TEXT,
        usado_em TEXT,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    )
`);

console.log("Tabelas verificadas/criadas com sucesso!");

// ============================
// PLANTA DO LOCAL (croqui/blueprint enviado pelo admin) + pontos marcados
// ============================
// Guarda a imagem da planta (uma por conta) e os pontos de cada unidade
// marcados sobre ela, em coordenadas percentuais (x/y de 0 a 100) — assim o
// marcador continua na posição certa não importa o tamanho em que a imagem
// for exibida na tela. É isso que permite montar o "cenário de rotas":
// cruzando esses pontos com as encomendas pendentes de cada unidade, o
// painel mostra na planta onde estão as entregas que faltam fazer.
db.exec(`
    CREATE TABLE IF NOT EXISTS plantas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER,
        imagem TEXT,
        atualizado_em TEXT,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS planta_pontos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER,
        unidade TEXT,
        x REAL,
        y REAL,
        criado_em TEXT,
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    )
`);

// Trata usuario_id ausente/0 como "sem dono" (NULL) em vez de tentar apontar
// para um usuário que não existe (id 0 nunca é criado, já que o SQLite
// começa o AUTOINCREMENT em 1) — isso é o que causava o erro
// "FOREIGN KEY constraint failed" quando o painel era usado sem login
// (modo demo, onde o front-end manda usuario_id = 0).
function sanitizarUsuarioId(usuario_id) {
    if (usuario_id === undefined || usuario_id === null) return null;
    const n = Number(usuario_id);
    return Number.isFinite(n) && n > 0 ? n : null;
}

// Monta a consulta certa dependendo se o usuario_id é "real" (compara com =)
// ou "modo demo" (compara com IS NULL, já que é assim que gravamos quando
// não há usuário logado). Sem isso, /api/.../0 nunca encontraria os
// registros salvos em modo demo, pois "usuario_id = 0" não bate com NULL.
function condicaoUsuarioId(usuario_id) {
    const id = sanitizarUsuarioId(usuario_id);
    return id === null
        ? { clausula: "usuario_id IS NULL", valor: [] }
        : { clausula: "usuario_id = ?", valor: [id] };
}

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

        const stmt = db.prepare(`
            INSERT INTO usuarios (nomeAdministrador, login, email, senha)
            VALUES (?, ?, ?, ?)
        `);
        stmt.run(nomeAdministrador, login, email, senha);

        return res.status(201).json({ sucesso: true, mensagem: "Conta criada com sucesso!" });
    } catch (error) {
        console.error("Erro ao salvar no banco (/api/registrar):", error.message);
        return res.status(400).json({
            sucesso: false,
            mensagem: "Erro ao salvar usuário. Este login ou e-mail já pode estar cadastrado."
        });
    }
});

// 2. ROTA DE CADASTRO COMPLETO (condomínio + conta do administrador)
app.post("/api/cadastro", (req, res) => {
    try {
        console.log("Dados de cadastro recebidos:", req.body);

        const {
            nomeCondominio, documento, cep, cidade, endereco, bairro, tipo,
            telefone, nomeResponsavel, email, senha
        } = req.body;

        if (!nomeCondominio || !documento || !cep || !cidade || !endereco || !bairro || !tipo || !email || !senha) {
            return res.status(400).json({
                sucesso: false,
                mensagem: "Preencha todos os campos obrigatórios."
            });
        }

        const login = email;
        const nomeAdministrador = nomeCondominio;

        const insertUsuario = db.prepare(`
            INSERT INTO usuarios (nomeAdministrador, login, email, senha)
            VALUES (?, ?, ?, ?)
        `);
        const infoUsuario = insertUsuario.run(nomeAdministrador, login, email, senha);
        const usuarioId = infoUsuario.lastInsertRowid;

        const insertCondominio = db.prepare(`
            INSERT INTO condominios (nome, documento, cep, cidade, endereco, bairro, tipo, telefone, nomeResponsavel, usuario_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        insertCondominio.run(nomeCondominio, documento, cep, cidade, endereco, bairro, tipo, telefone || null, nomeResponsavel || null, usuarioId);

        return res.status(201).json({
            sucesso: true,
            mensagem: "Cadastro realizado com sucesso!",
            usuario: { id: usuarioId, nome: nomeAdministrador, login: login, email: email }
        });
    } catch (error) {
        console.error("Erro ao criar cadastro (/api/cadastro):", error.message);
        return res.status(400).json({
            sucesso: false,
            mensagem: "Não foi possível criar a conta. Este e-mail já pode estar cadastrado."
        });
    }
});

// 2.1 ROTAS DE CONDOMÍNIOS/EMPRESAS CADASTRADOS NA CONTA
// Usadas pela tela "Condomínios" do painel (zibbox-painel.html). Uma mesma
// conta (usuario_id) pode ter vários condomínios/empresas cadastrados —
// o primeiro nasce junto com a conta em /api/cadastro, os demais são
// adicionados por aqui direto do painel, sem precisar criar login novo.

// Lista todos os condomínios da conta logada.
app.get("/api/condominio/:usuario_id", (req, res) => {
    try {
        const { clausula, valor } = condicaoUsuarioId(req.params.usuario_id);

        const condominios = db
            .prepare(`
                SELECT c.id, c.nome, c.documento, c.cep, c.cidade, c.endereco, c.bairro, c.tipo,
                       c.telefone, c.nomeResponsavel, c.latitude, c.longitude,
                       u.email
                FROM condominios c
                LEFT JOIN usuarios u ON u.id = c.usuario_id
                WHERE c.${clausula}
                ORDER BY c.id ASC
            `)
            .all(...valor);

        return res.json({ sucesso: true, condominios });
    } catch (error) {
        console.error("Erro ao buscar condomínios (/api/condominio):", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro interno no servidor." });
    }
});

// Cadastra mais um condomínio/empresa na mesma conta já logada.
app.post("/api/condominio", (req, res) => {
    try {
        const {
            usuario_id, nome, tipo, documento, telefone, cep, cidade, endereco, bairro, nomeResponsavel,
            latitude, longitude
        } = req.body;

        if (!nome || !tipo || !documento || !cep || !cidade || !endereco || !bairro) {
            return res.status(400).json({
                sucesso: false,
                mensagem: "Preencha todos os campos obrigatórios."
            });
        }

        const stmt = db.prepare(`
            INSERT INTO condominios (nome, documento, cep, cidade, endereco, bairro, tipo, telefone, nomeResponsavel, usuario_id, latitude, longitude)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const info = stmt.run(
            nome, documento, cep, cidade, endereco, bairro, tipo,
            telefone || null, nomeResponsavel || null, sanitizarUsuarioId(usuario_id),
            latitude || null, longitude || null
        );

        return res.status(201).json({ sucesso: true, id: info.lastInsertRowid });
    } catch (error) {
        console.error("Erro ao cadastrar condomínio (/api/condominio):", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro ao salvar condomínio: " + error.message });
    }
});

// Edita um condomínio já cadastrado.
app.patch("/api/condominio/:id", (req, res) => {
    try {
        const { id } = req.params;
        const { nome, tipo, documento, telefone, cep, cidade, endereco, bairro, nomeResponsavel, latitude, longitude } = req.body;

        const campos = [];
        const valores = [];
        if (nome !== undefined) { campos.push("nome = ?"); valores.push(nome); }
        if (tipo !== undefined) { campos.push("tipo = ?"); valores.push(tipo); }
        if (documento !== undefined) { campos.push("documento = ?"); valores.push(documento); }
        if (telefone !== undefined) { campos.push("telefone = ?"); valores.push(telefone); }
        if (cep !== undefined) { campos.push("cep = ?"); valores.push(cep); }
        if (cidade !== undefined) { campos.push("cidade = ?"); valores.push(cidade); }
        if (endereco !== undefined) { campos.push("endereco = ?"); valores.push(endereco); }
        if (bairro !== undefined) { campos.push("bairro = ?"); valores.push(bairro); }
        if (nomeResponsavel !== undefined) { campos.push("nomeResponsavel = ?"); valores.push(nomeResponsavel); }
        if (latitude !== undefined) { campos.push("latitude = ?"); valores.push(latitude); }
        if (longitude !== undefined) { campos.push("longitude = ?"); valores.push(longitude); }

        if (!campos.length) {
            return res.status(400).json({ sucesso: false, mensagem: "Nada para atualizar." });
        }

        valores.push(id);
        const stmt = db.prepare(`UPDATE condominios SET ${campos.join(", ")} WHERE id = ?`);
        const info = stmt.run(...valores);

        if (info.changes === 0) {
            return res.status(404).json({ sucesso: false, mensagem: "Condomínio não encontrado." });
        }
        return res.json({ sucesso: true });
    } catch (error) {
        console.error("Erro ao atualizar condomínio:", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro ao atualizar condomínio." });
    }
});

// Remove um condomínio cadastrado.
app.delete("/api/condominio/:id", (req, res) => {
    try {
        const { id } = req.params;
        const info = db.prepare(`DELETE FROM condominios WHERE id = ?`).run(id);
        if (info.changes === 0) {
            return res.status(404).json({ sucesso: false, mensagem: "Condomínio não encontrado." });
        }
        return res.json({ sucesso: true });
    } catch (error) {
        console.error("Erro ao remover condomínio:", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro ao remover condomínio." });
    }
});

// 3. ROTA DE LOGIN
app.post("/api/login", (req, res) => {
    try {
        console.log("Tentativa de login recebida:", req.body);
        const identificador = req.body.login || req.body.email;
        const { senha } = req.body;

        if (!identificador || !senha) {
            return res.status(400).json({ sucesso: false, mensagem: "Informe login e senha." });
        }

        const usuario = db
            .prepare(`SELECT * FROM usuarios WHERE (login = ? OR email = ?) AND senha = ?`)
            .get(identificador, identificador, senha);

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
    } catch (error) {
        console.error("Erro interno no servidor (/api/login):", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro interno no servidor." });
    }
});

// ============================
// LOGIN COM GOOGLE
// ============================
// Este valor TEM que ser exatamente o mesmo Client ID configurado no
// front-end (constante GOOGLE_CLIENT_ID em criar-login.html), senão a
// validação abaixo rejeita o token (erro "token não pertence a este app").
// Pode ser configurado também por variável de ambiente, sem editar o código.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "SEU_GOOGLE_CLIENT_ID.apps.googleusercontent.com";

if (GOOGLE_CLIENT_ID.startsWith("SEU_")) {
    console.warn("\n⚠️  GOOGLE_CLIENT_ID não configurado em server.js — o login com Google vai falhar até você configurá-lo (veja o topo do arquivo).\n");
}

// 3.1 ROTA DE LOGIN COM GOOGLE
app.post("/api/login-google", async (req, res) => {
    try {
        const { credential } = req.body;
        if (!credential) {
            return res.status(400).json({ sucesso: false, mensagem: "Token do Google ausente." });
        }

        if (GOOGLE_CLIENT_ID.startsWith("SEU_")) {
            return res.status(500).json({
                sucesso: false,
                mensagem: "GOOGLE_CLIENT_ID não configurado no servidor. Edite a constante GOOGLE_CLIENT_ID no topo do server.js."
            });
        }

        // Valida o token direto com o Google — sem precisar de biblioteca extra.
        // (Requer Node 18+ por causa do fetch global; server.js já pressupõe isso.)
        let payload;
        try {
            const verifyResp = await fetch(
                `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`
            );
            if (!verifyResp.ok) {
                return res.status(401).json({ sucesso: false, mensagem: "Token do Google inválido ou expirado. Tente entrar novamente." });
            }
            payload = await verifyResp.json();
        } catch (netErr) {
            console.error("Erro ao contatar o Google para validar o token:", netErr.message);
            return res.status(502).json({ sucesso: false, mensagem: "Não foi possível validar o token com o Google. Verifique a conexão do servidor com a internet." });
        }

        if (payload.aud !== GOOGLE_CLIENT_ID) {
            console.error("Token do Google com 'aud' diferente do GOOGLE_CLIENT_ID configurado.", { esperado: GOOGLE_CLIENT_ID, recebido: payload.aud });
            return res.status(401).json({ sucesso: false, mensagem: "Token do Google não pertence a este aplicativo (Client ID não bate)." });
        }

        const email = payload.email;
        const nome = payload.name || email;
        if (!email) {
            return res.status(400).json({ sucesso: false, mensagem: "Não foi possível obter o e-mail da conta Google." });
        }

        let usuario = db.prepare(`SELECT * FROM usuarios WHERE email = ?`).get(email);

        if (!usuario) {
            // Conta nova: cria o usuário com uma senha aleatória (login por senha
            // continua desativado para essa conta, já que ela entra via Google).
            const senhaAleatoria = "google_" + Math.random().toString(36).slice(2) + Date.now();
            const info = db.prepare(`
                INSERT INTO usuarios (nomeAdministrador, login, email, senha)
                VALUES (?, ?, ?, ?)
            `).run(nome, email, email, senhaAleatoria);
            usuario = { id: info.lastInsertRowid, nomeAdministrador: nome, login: email, email };
            console.log("Novo usuário criado via Google:", email);
        } else {
            console.log("Usuário autenticado via Google:", email);
        }

        return res.json({
            sucesso: true,
            mensagem: "Logado com Google com sucesso!",
            usuario: {
                id: usuario.id,
                nome: usuario.nomeAdministrador,
                login: usuario.login,
                email: usuario.email,
                foto: payload.picture || null
            }
        });
    } catch (error) {
        console.error("Erro interno no login com Google (/api/login-google):", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro interno no servidor." });
    }
});

// ============================
// ROTAS: MORADORES
// ============================

app.get("/api/moradores/:usuario_id", (req, res) => {
    try {
        const { clausula, valor } = condicaoUsuarioId(req.params.usuario_id);
        const rows = db
            .prepare(`SELECT * FROM moradores WHERE ${clausula} ORDER BY id ASC`)
            .all(...valor);
        return res.json({ sucesso: true, moradores: rows });
    } catch (error) {
        console.error("Erro ao listar moradores:", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro ao buscar moradores." });
    }
});

app.post("/api/moradores", (req, res) => {
    try {
        const { usuario_id, unidade, nome, foto } = req.body;

        if (!unidade || !nome) {
            return res.status(400).json({ sucesso: false, mensagem: "Preencha unidade e nome do morador." });
        }

        const stmt = db.prepare(`INSERT INTO moradores (usuario_id, unidade, nome, foto) VALUES (?, ?, ?, ?)`);
        const info = stmt.run(sanitizarUsuarioId(usuario_id), unidade, nome, foto ?? null);

        return res.status(201).json({ sucesso: true, id: info.lastInsertRowid });
    } catch (error) {
        console.error("Erro ao cadastrar morador:", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro ao salvar morador: " + error.message });
    }
});

// ============================
// ROTAS: ENCOMENDAS
// ============================

app.get("/api/encomendas/:usuario_id", (req, res) => {
    try {
        const { clausula, valor } = condicaoUsuarioId(req.params.usuario_id);
        const rows = db
            .prepare(`SELECT * FROM encomendas WHERE ${clausula} ORDER BY codigo ASC`)
            .all(...valor);
        const encomendas = rows.map((e) => ({ ...e, privada: !!e.privada }));
        return res.json({ sucesso: true, encomendas });
    } catch (error) {
        console.error("Erro ao listar encomendas:", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro ao buscar encomendas." });
    }
});

// Registra uma nova encomenda
app.post("/api/encomendas", (req, res) => {
    try {
        const {
            usuario_id, unidade, nome, transp, tipo, grupo,
            codigoRastreio, entregadorNome, entregadorDoc, observacao,
            foto, escaninho, status, privada, ts, por
        } = req.body;

        if (!unidade || !nome) {
            return res.status(400).json({ sucesso: false, mensagem: "Preencha unidade e destinatário." });
        }

        const stmt = db.prepare(`
            INSERT INTO encomendas (
                usuario_id, unidade, nome, transp, tipo, grupo, codigoRastreio,
                entregadorNome, entregadorDoc, observacao, foto, escaninho, status, privada, ts, por
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const info = stmt.run(
            sanitizarUsuarioId(usuario_id),
            unidade,
            nome,
            transp || "Transportadora",
            tipo || "Pacote",
            grupo || 1,
            codigoRastreio || "",
            entregadorNome || "",
            entregadorDoc || "",
            observacao || "",
            foto ?? null,
            escaninho ?? null,
            status || "recebido",
            privada ? 1 : 0,
            ts ?? null,
            por ?? null
        );

        console.log(`Encomenda registrada com sucesso — código ${info.lastInsertRowid}, unidade ${unidade}`);
        return res.status(201).json({ sucesso: true, codigo: info.lastInsertRowid });
    } catch (error) {
        console.error("Erro ao registrar encomenda:", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro ao salvar encomenda: " + error.message });
    }
});

// Atualiza status/escaninho de uma encomenda
app.patch("/api/encomendas/:codigo", (req, res) => {
    try {
        const { codigo } = req.params;
        const { status, escaninho, responsavelRetirada } = req.body;

        const campos = [];
        const valores = [];
        if (status !== undefined) { campos.push("status = ?"); valores.push(status); }
        if (escaninho !== undefined) { campos.push("escaninho = ?"); valores.push(escaninho); }
        if (responsavelRetirada !== undefined) { campos.push("responsavelRetirada = ?"); valores.push(responsavelRetirada); }

        if (!campos.length) {
            return res.status(400).json({ sucesso: false, mensagem: "Nada para atualizar." });
        }

        valores.push(codigo);
        const stmt = db.prepare(`UPDATE encomendas SET ${campos.join(", ")} WHERE codigo = ?`);
        const info = stmt.run(...valores);

        if (info.changes === 0) {
            return res.status(404).json({ sucesso: false, mensagem: "Encomenda não encontrada." });
        }
        return res.json({ sucesso: true });
    } catch (error) {
        console.error("Erro ao atualizar encomenda:", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro ao atualizar encomenda." });
    }
});

// Confirma a retirada de uma ou mais encomendas: marca como "entregue" e
// grava quem retirou (nome/CPF) e as duas assinaturas (funcionário e quem
// retirou), coletadas na tela de Assinatura do painel.
app.post("/api/encomendas/retirar", (req, res) => {
    try {
        const { codigos, retiradoPor, retiradoDoc, assinaturaFuncionario, assinaturaRetirada } = req.body;

        if (!Array.isArray(codigos) || codigos.length === 0) {
            return res.status(400).json({ sucesso: false, mensagem: "Nenhuma encomenda selecionada para retirada." });
        }
        if (!retiradoPor) {
            return res.status(400).json({ sucesso: false, mensagem: "Informe quem está retirando a encomenda." });
        }

        const stmt = db.prepare(`
            UPDATE encomendas
            SET status = 'entregue',
                retiradoPor = ?,
                retiradoDoc = ?,
                assinaturaFuncionario = ?,
                assinaturaRetirada = ?,
                retiradoTs = ?
            WHERE codigo = ?
        `);
        const ts = new Date().toISOString();

        // Transação: ou confirma a retirada de todas as encomendas
        // selecionadas, ou nenhuma (evita ficar com retirada "pela metade"
        // se algo der errado no meio da lista).
        const confirmarTodas = db.transaction((lista) => {
            let alterados = 0;
            for (const codigo of lista) {
                const info = stmt.run(
                    retiradoPor,
                    retiradoDoc || "",
                    assinaturaFuncionario || null,
                    assinaturaRetirada || null,
                    ts,
                    codigo
                );
                alterados += info.changes;
            }
            return alterados;
        });

        const alterados = confirmarTodas(codigos);

        if (alterados === 0) {
            return res.status(404).json({ sucesso: false, mensagem: "Encomenda(s) não encontrada(s)." });
        }

        console.log(`Retirada confirmada — códigos [${codigos.join(", ")}], retirado por ${retiradoPor}`);
        return res.json({ sucesso: true, alterados });
    } catch (error) {
        console.error("Erro ao confirmar retirada (/api/encomendas/retirar):", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro ao confirmar retirada: " + error.message });
    }
});

// ============================
// ROTAS: TIMELINE (histórico)
// ============================

app.get("/api/timeline/:usuario_id", (req, res) => {
    try {
        const { clausula, valor } = condicaoUsuarioId(req.params.usuario_id);
        const rows = db
            .prepare(`SELECT * FROM timeline WHERE ${clausula} ORDER BY id DESC LIMIT 50`)
            .all(...valor);
        return res.json({ sucesso: true, timeline: rows });
    } catch (error) {
        console.error("Erro ao listar timeline:", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro ao buscar histórico." });
    }
});

app.post("/api/timeline", (req, res) => {
    try {
        const { usuario_id, tipo, unidade, texto, ts, por } = req.body;
        const stmt = db.prepare(`INSERT INTO timeline (usuario_id, tipo, unidade, texto, ts, por) VALUES (?, ?, ?, ?, ?, ?)`);
        const info = stmt.run(sanitizarUsuarioId(usuario_id), tipo, unidade, texto, ts ?? null, por ?? null);
        return res.status(201).json({ sucesso: true, id: info.lastInsertRowid });
    } catch (error) {
        console.error("Erro ao salvar timeline:", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro ao salvar histórico." });
    }
});

// ============================
// ROTAS: FUNCIONÁRIOS (equipe da portaria)
// ============================

app.get("/api/funcionarios/:usuario_id", (req, res) => {
    try {
        const { clausula, valor } = condicaoUsuarioId(req.params.usuario_id);
        const rows = db
            .prepare(`SELECT * FROM funcionarios WHERE ${clausula} ORDER BY id ASC`)
            .all(...valor);
        // Remove a senha antes de enviar — essa lista vai tanto pro painel do
        // admin quanto pro portal do funcionário, nenhum dos dois precisa
        // (nem deve) receber a senha dos outros.
        const funcionarios = rows.map(({ senha, ...f }) => ({ ...f, online: !!f.online }));
        return res.json({ sucesso: true, funcionarios });
    } catch (error) {
        console.error("Erro ao listar funcionários:", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro ao buscar funcionários." });
    }
});

app.post("/api/funcionarios", (req, res) => {
    try {
        const { usuario_id, nome, cargo, foto, documento, senha } = req.body;
        if (!nome) {
            return res.status(400).json({ sucesso: false, mensagem: "Preencha o nome do funcionário." });
        }
        // Se um documento foi informado, ele precisa ser único — é o login do
        // funcionário no portal, então dois funcionários com o mesmo CPF
        // fariam login um no lugar do outro.
        if (documento) {
            const existente = db.prepare(`SELECT id FROM funcionarios WHERE documento = ?`).get(documento);
            if (existente) {
                return res.status(409).json({ sucesso: false, mensagem: "Já existe um funcionário cadastrado com esse documento." });
            }
        }
        const stmt = db.prepare(`
            INSERT INTO funcionarios (usuario_id, nome, cargo, foto, documento, senha, online, criado_em)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?)
        `);
        const info = stmt.run(
            sanitizarUsuarioId(usuario_id),
            nome,
            cargo || "Responsável pelo recebimento",
            foto ?? null,
            documento || null,
            senha || null,
            new Date().toISOString()
        );
        return res.status(201).json({ sucesso: true, id: info.lastInsertRowid });
    } catch (error) {
        console.error("Erro ao cadastrar funcionário:", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro ao salvar funcionário: " + error.message });
    }
});

// Login do funcionário no portal (funcionario-login.html), autenticando por
// documento + senha cadastrados pelo administrador na tela de Funcionários.
app.post("/api/funcionarios/login", (req, res) => {
    try {
        const { documento, senha } = req.body;
        if (!documento || !senha) {
            return res.status(400).json({ sucesso: false, mensagem: "Informe o documento e a senha." });
        }
        const funcionario = db
            .prepare(`SELECT * FROM funcionarios WHERE documento = ? AND senha = ?`)
            .get(documento, senha);

        if (!funcionario) {
            return res.status(401).json({ sucesso: false, mensagem: "Documento ou senha inválidos." });
        }

        db.prepare(`UPDATE funcionarios SET online = 1 WHERE id = ?`).run(funcionario.id);

        const { senha: _senha, ...funcionarioSemSenha } = funcionario;
        return res.json({ sucesso: true, funcionario: { ...funcionarioSemSenha, online: true } });
    } catch (error) {
        console.error("Erro no login do funcionário:", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro ao entrar no portal." });
    }
});

// Logout do funcionário (marca offline). Também recebido via
// navigator.sendBeacon quando a aba é fechada, por isso aceita corpo vazio.
app.post("/api/funcionarios/:id/logout", (req, res) => {
    try {
        const { id } = req.params;
        db.prepare(`UPDATE funcionarios SET online = 0 WHERE id = ?`).run(id);
        return res.json({ sucesso: true });
    } catch (error) {
        console.error("Erro no logout do funcionário:", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro ao sair do portal." });
    }
});

// Alterna/atualiza o status online de um funcionário, ou edita nome/cargo
app.patch("/api/funcionarios/:id", (req, res) => {
    try {
        const { id } = req.params;
        const { online, nome, cargo, documento, senha } = req.body;

        const campos = [];
        const valores = [];
        if (online !== undefined) { campos.push("online = ?"); valores.push(online ? 1 : 0); }
        if (nome !== undefined) { campos.push("nome = ?"); valores.push(nome); }
        if (cargo !== undefined) { campos.push("cargo = ?"); valores.push(cargo); }
        if (documento !== undefined) { campos.push("documento = ?"); valores.push(documento); }
        if (senha !== undefined && senha !== "") { campos.push("senha = ?"); valores.push(senha); }

        if (!campos.length) {
            return res.status(400).json({ sucesso: false, mensagem: "Nada para atualizar." });
        }

        valores.push(id);
        const stmt = db.prepare(`UPDATE funcionarios SET ${campos.join(", ")} WHERE id = ?`);
        const info = stmt.run(...valores);

        if (info.changes === 0) {
            return res.status(404).json({ sucesso: false, mensagem: "Funcionário não encontrado." });
        }
        return res.json({ sucesso: true });
    } catch (error) {
        console.error("Erro ao atualizar funcionário:", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro ao atualizar funcionário." });
    }
});

app.delete("/api/funcionarios/:id", (req, res) => {
    try {
        const { id } = req.params;
        const info = db.prepare(`DELETE FROM funcionarios WHERE id = ?`).run(id);
        if (info.changes === 0) {
            return res.status(404).json({ sucesso: false, mensagem: "Funcionário não encontrado." });
        }
        return res.json({ sucesso: true });
    } catch (error) {
        console.error("Erro ao remover funcionário:", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro ao remover funcionário." });
    }
});

// ============================
// ROTAS: PLANTA DO LOCAL (croqui) + PONTOS DAS UNIDADES
// ============================
// Uma planta por conta (usuario_id). Front-end manda a imagem já em
// base64 (mesmo padrão usado pra fotos de moradores/funcionários), então
// aqui é só guardar/substituir.

app.get("/api/planta/:usuario_id", (req, res) => {
    try {
        const { clausula, valor } = condicaoUsuarioId(req.params.usuario_id);

        const planta = db
            .prepare(`SELECT imagem, atualizado_em FROM plantas WHERE ${clausula} ORDER BY id DESC LIMIT 1`)
            .get(...valor);

        const pontos = db
            .prepare(`SELECT id, unidade, x, y FROM planta_pontos WHERE ${clausula} ORDER BY id ASC`)
            .all(...valor);

        return res.json({
            sucesso: true,
            imagem: planta ? planta.imagem : null,
            atualizadoEm: planta ? planta.atualizado_em : null,
            pontos
        });
    } catch (error) {
        console.error("Erro ao buscar planta:", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro ao buscar a planta do local." });
    }
});

// Envia/substitui a imagem da planta da conta (upsert: se já existir uma,
// atualiza; senão, cria a primeira).
app.post("/api/planta", (req, res) => {
    try {
        const { usuario_id, imagem } = req.body;
        if (!imagem) {
            return res.status(400).json({ sucesso: false, mensagem: "Nenhuma imagem enviada." });
        }
        const id = sanitizarUsuarioId(usuario_id);
        const { clausula, valor } = condicaoUsuarioId(usuario_id);

        const existente = db.prepare(`SELECT id FROM plantas WHERE ${clausula} ORDER BY id DESC LIMIT 1`).get(...valor);
        const agora = new Date().toISOString();

        if (existente) {
            db.prepare(`UPDATE plantas SET imagem = ?, atualizado_em = ? WHERE id = ?`).run(imagem, agora, existente.id);
        } else {
            db.prepare(`INSERT INTO plantas (usuario_id, imagem, atualizado_em) VALUES (?, ?, ?)`).run(id, imagem, agora);
        }

        return res.json({ sucesso: true });
    } catch (error) {
        console.error("Erro ao salvar planta:", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro ao salvar a planta: " + error.message });
    }
});

// Marca (ou remarca) a posição de uma unidade sobre a planta. Se a unidade
// já tiver um ponto salvo, substitui a posição em vez de duplicar.
app.post("/api/planta/pontos", (req, res) => {
    try {
        const { usuario_id, unidade, x, y } = req.body;
        if (!unidade || x === undefined || y === undefined) {
            return res.status(400).json({ sucesso: false, mensagem: "Informe a unidade e a posição (x, y) na planta." });
        }
        const id = sanitizarUsuarioId(usuario_id);
        const { clausula, valor } = condicaoUsuarioId(usuario_id);

        const existente = db
            .prepare(`SELECT id FROM planta_pontos WHERE ${clausula} AND unidade = ?`)
            .get(...valor, unidade);

        if (existente) {
            db.prepare(`UPDATE planta_pontos SET x = ?, y = ? WHERE id = ?`).run(x, y, existente.id);
            return res.json({ sucesso: true, id: existente.id });
        }

        const info = db
            .prepare(`INSERT INTO planta_pontos (usuario_id, unidade, x, y, criado_em) VALUES (?, ?, ?, ?, ?)`)
            .run(id, unidade, x, y, new Date().toISOString());

        return res.status(201).json({ sucesso: true, id: info.lastInsertRowid });
    } catch (error) {
        console.error("Erro ao salvar ponto da planta:", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro ao marcar a unidade na planta: " + error.message });
    }
});

app.delete("/api/planta/pontos/:id", (req, res) => {
    try {
        const { id } = req.params;
        const info = db.prepare(`DELETE FROM planta_pontos WHERE id = ?`).run(id);
        if (info.changes === 0) {
            return res.status(404).json({ sucesso: false, mensagem: "Ponto não encontrado." });
        }
        return res.json({ sucesso: true });
    } catch (error) {
        console.error("Erro ao remover ponto da planta:", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro ao remover ponto da planta." });
    }
});

// ============================
// ROTAS: CONVITES (cadastro de morador por link)
// ============================
// Fluxo: o admin gera um convite (com telefone/e-mail e, opcionalmente, a
// unidade). O sistema devolve um link único (/convite.html?token=...) que o
// admin envia manualmente pelo WhatsApp/e-mail — este servidor não dispara
// SMS/e-mail sozinho, pois isso exige uma conta paga em um provedor externo
// (ex: Twilio, SendGrid). Quando o morador abre o link e preenche o nome
// dele, o cadastro é salvo automaticamente na tabela de moradores.

function gerarToken() {
    return (
        Math.random().toString(36).slice(2) +
        Math.random().toString(36).slice(2) +
        Date.now().toString(36)
    );
}

// Cria um novo convite e devolve o link pronto
app.post("/api/convites", (req, res) => {
    try {
        const { usuario_id, tipo, contato, unidade } = req.body;
        if (!contato) {
            return res.status(400).json({ sucesso: false, mensagem: "Informe um telefone ou e-mail de contato." });
        }
        const token = gerarToken();
        const stmt = db.prepare(`
            INSERT INTO convites (usuario_id, tipo, contato, unidade, token, usado, criado_em)
            VALUES (?, ?, ?, ?, ?, 0, ?)
        `);
        stmt.run(usuario_id ?? null, tipo || "morador", contato, unidade || "", token, new Date().toISOString());

        const baseUrl = `${req.protocol}://${req.get("host")}`;
        const link = `${baseUrl}/convite.html?token=${token}`;

        return res.status(201).json({ sucesso: true, token, link });
    } catch (error) {
        console.error("Erro ao gerar convite:", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro ao gerar convite." });
    }
});

// Consulta os dados de um convite (usado pela página pública convite.html)
app.get("/api/convites/:token", (req, res) => {
    try {
        const { token } = req.params;
        const convite = db.prepare(`SELECT * FROM convites WHERE token = ?`).get(token);
        if (!convite) {
            return res.status(404).json({ sucesso: false, mensagem: "Convite não encontrado. Peça um novo link ao síndico/portaria." });
        }
        if (convite.usado) {
            return res.status(410).json({ sucesso: false, mensagem: "Este convite já foi usado." });
        }
        return res.json({
            sucesso: true,
            convite: { tipo: convite.tipo, unidade: convite.unidade, contato: convite.contato }
        });
    } catch (error) {
        console.error("Erro ao buscar convite:", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro ao buscar convite." });
    }
});

// O morador/funcionário preenche o formulário da página pública e este
// endpoint salva o cadastro de verdade, vinculado ao condomínio do convite.
app.post("/api/convites/:token/preencher", (req, res) => {
    try {
        const { token } = req.params;
        const { nome, unidade, foto } = req.body;

        const convite = db.prepare(`SELECT * FROM convites WHERE token = ?`).get(token);
        if (!convite) {
            return res.status(404).json({ sucesso: false, mensagem: "Convite não encontrado." });
        }
        if (convite.usado) {
            return res.status(410).json({ sucesso: false, mensagem: "Este convite já foi usado." });
        }
        if (!nome) {
            return res.status(400).json({ sucesso: false, mensagem: "Informe seu nome." });
        }
        const unidadeFinal = convite.unidade || unidade;
        if (!unidadeFinal) {
            return res.status(400).json({ sucesso: false, mensagem: "Informe a unidade." });
        }

        let novoId;
        if (convite.tipo === "funcionario") {
            const info = db.prepare(`
                INSERT INTO funcionarios (usuario_id, nome, cargo, foto, online, criado_em)
                VALUES (?, ?, ?, ?, 0, ?)
            `).run(convite.usuario_id, nome, "Responsável pelo recebimento", foto ?? null, new Date().toISOString());
            novoId = info.lastInsertRowid;
        } else {
            const info = db.prepare(`
                INSERT INTO moradores (usuario_id, unidade, nome, foto)
                VALUES (?, ?, ?, ?)
            `).run(convite.usuario_id, unidadeFinal, nome, foto ?? null);
            novoId = info.lastInsertRowid;
        }

        db.prepare(`UPDATE convites SET usado = 1, usado_em = ? WHERE token = ?`)
          .run(new Date().toISOString(), token);

        return res.status(201).json({ sucesso: true, id: novoId });
    } catch (error) {
        console.error("Erro ao concluir cadastro via convite:", error.message);
        return res.status(500).json({ sucesso: false, mensagem: "Erro ao salvar cadastro." });
    }
});

// Rota raiz: redireciona para a tela de login
app.get("/", (req, res) => {
    res.redirect("/login.html");
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
    console.log(`Banco: ${path.join(__dirname, "banco.sqlite")}`);
    console.log(`==========================================\n`);
});