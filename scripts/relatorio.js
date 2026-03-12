// ============================================================
//  FuelTracker Pro — Relatório Mensal Automático de Eficiência
//  Roda todo dia 15 via GitHub Actions
// ============================================================

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { Resend } from 'resend';

// ─────────────────────────────────────────────────────────────
//  ⚙️  CONFIGURAÇÃO — edite aqui os grupos, operações e e-mails
// ─────────────────────────────────────────────────────────────
const GRUPOS = [
  {
    nome: 'CENIBRA',
    // Todas as operações CENIBRA vão pro mesmo e-mail
    operacoes: [
      'CENIBRA COCAIS/RIO DOCE',
      'CENIBRA NOVA ERA',
      'CENIBRA SANTA BARBARA',
    ],
    destinatarios: [
      'eulernascimento@expressonepomuceno.com.br',
    ],
  },
  {
    nome: 'CMPC FLORESTAL',
    operacoes: ['CMPC FLORESTAL'],
    destinatarios: [
      'eulernascimento@expressonepomuceno.com.br',
    ],
  },
  {
    nome: 'SUZANO ARACRUZ',
    operacoes: ['SUZANO ARACRUZ'],
    destinatarios: [
      'eulernascimento@expressonepomuceno.com.br',
    ],
  },
  {
    nome: 'SUZANO RIBAS',
    operacoes: ['SUZANO RIBAS'],
    destinatarios: [
      'eulernascimento@expressonepomuceno.com.br',
    ],
  },
  // ← adicione mais grupos conforme necessário
];

// Limite de eficiência — máquinas ABAIXO desse % aparecem no relatório
const LIMITE_EFICIENCIA = 98;

// Janela de dados: quantos dias anteriores considerar (ex: 30 = último mês)
const DIAS_JANELA = 30;
// ─────────────────────────────────────────────────────────────


// ── Inicialização Firebase ────────────────────────────────────
initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    // Firebase Admin usa service account — aqui usamos a API Key
    // simplificada via REST (sem service account necessário)
  }),
});

// Como não temos service account, vamos usar a API REST do Firestore diretamente
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const API_KEY = process.env.FIREBASE_API_KEY;

async function firestoreGet(collection) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collection}?key=${API_KEY}&pageSize=1000`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Firestore error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.documents || []).map(doc => {
    const fields = doc.fields || {};
    const obj = {};
    for (const [k, v] of Object.entries(fields)) {
      obj[k] = v.stringValue ?? v.integerValue ?? v.doubleValue ?? v.booleanValue ?? v.mapValue ?? null;
      // Converte números string para number
      if (typeof obj[k] === 'string' && !isNaN(obj[k])) obj[k] = parseFloat(obj[k]);
    }
    return obj;
  });
}

// ── Lógica principal ──────────────────────────────────────────
async function gerarRelatorio() {
  console.log('📊 Iniciando geração do relatório...');

  // Busca dados do Firebase
  const [abastecimentos, maquinas] = await Promise.all([
    firestoreGet('abastecimentos'),
    firestoreGet('maquinas'),
  ]);

  console.log(`✅ ${abastecimentos.length} abastecimentos, ${maquinas.length} máquinas carregados`);

  // Mapa de máquinas para lookup rápido
  const maqMap = {};
  maquinas.forEach(m => { maqMap[m.placa] = m; });

  // Filtra pela janela de tempo
  const dataCorte = new Date();
  dataCorte.setDate(dataCorte.getDate() - DIAS_JANELA);
  const dataCorteStr = dataCorte.toISOString().split('T')[0];

  const recentes = abastecimentos.filter(a => a.data >= dataCorteStr);
  console.log(`📅 ${recentes.length} registros nos últimos ${DIAS_JANELA} dias`);

  // Agrupa por máquina
  const byMaq = {};
  recentes.forEach(a => {
    if (!byMaq[a.placa]) byMaq[a.placa] = { litros: 0, horas: 0 };
    byMaq[a.placa].litros += a.litros || 0;
    byMaq[a.placa].horas += a.horas || 0;
  });

  // Calcula eficiência vs meta
  const maquinasComProblema = [];
  for (const [placa, dados] of Object.entries(byMaq)) {
    const maq = maqMap[placa];
    if (!maq || !maq.meta || maq.meta <= 0) continue;
    if (dados.horas <= 0) continue;

    const mediaReal = dados.litros / dados.horas;
    const eficiencia = (maq.meta / mediaReal) * 100; // 100% = consumindo exatamente a meta
    // Se media > meta, eficiencia < 100% (consumindo mais que o esperado)

    if (eficiencia < LIMITE_EFICIENCIA) {
      maquinasComProblema.push({
        placa,
        operacao: maq.operacao || 'Sem Operação',
        mediaReal: mediaReal.toFixed(2),
        meta: maq.meta.toFixed(1),
        eficiencia: eficiencia.toFixed(1),
        desvio: ((mediaReal - maq.meta) / maq.meta * 100).toFixed(1),
        litros: dados.litros.toFixed(0),
        horas: dados.horas.toFixed(0),
      });
    }
  }

  console.log(`⚠️  ${maquinasComProblema.length} máquinas abaixo de ${LIMITE_EFICIENCIA}% de eficiência`);

  if (maquinasComProblema.length === 0) {
    console.log('✅ Nenhuma máquina fora do limite — nenhum e-mail enviado');
    return;
  }

  // Envia e-mail por grupo
  const resend = new Resend(process.env.RESEND_API_KEY);
  const mes = new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

  for (const grupo of GRUPOS) {
    const maqsDoGrupo = maquinasComProblema
      .filter(m => grupo.operacoes.some(op =>
        m.operacao.toUpperCase().includes(op.toUpperCase()) ||
        op.toUpperCase().includes(m.operacao.toUpperCase())
      ))
      .sort((a, b) => parseFloat(a.eficiencia) - parseFloat(b.eficiencia)); // pior primeiro

    if (maqsDoGrupo.length === 0) {
      console.log(`✅ ${grupo.nome} — todas dentro do limite, e-mail não enviado`);
      continue;
    }

    const html = gerarHTML(grupo.nome, maqsDoGrupo, mes, DIAS_JANELA, LIMITE_EFICIENCIA);

    try {
      await resend.emails.send({
        from: process.env.EMAIL_REMETENTE, // ex: FuelTracker <relatorio@seudominio.com>
        to: grupo.destinatarios,
        subject: `⚠️ FuelTracker — Alerta de Eficiência ${grupo.nome} · ${mes}`,
        html,
      });
      console.log(`📧 E-mail enviado para ${grupo.nome} (${grupo.destinatarios.join(', ')})`);
    } catch (err) {
      console.error(`❌ Erro ao enviar para ${grupo.nome}:`, err.message);
    }
  }

  console.log('🏁 Relatório concluído');
}

// ── Template HTML do e-mail ───────────────────────────────────
function gerarHTML(nomeGrupo, maquinas, mes, diasJanela, limite) {
  const linhas = maquinas.map(m => {
    const cor = parseFloat(m.eficiencia) < 90 ? '#ef4444' :
                parseFloat(m.eficiencia) < 95 ? '#f97316' : '#f59e0b';
    return `
      <tr style="border-bottom:1px solid #e5e7eb">
        <td style="padding:10px 12px;font-weight:600;color:#111827">${m.placa}</td>
        <td style="padding:10px 12px;color:#6b7280;font-size:13px">${m.operacao}</td>
        <td style="padding:10px 12px;text-align:center;font-family:monospace;color:#3b82f6;font-weight:700">${m.meta} L/h</td>
        <td style="padding:10px 12px;text-align:center;font-family:monospace;color:${cor};font-weight:700">${m.mediaReal} L/h</td>
        <td style="padding:10px 12px;text-align:center;font-family:monospace;color:${cor};font-weight:700">+${m.desvio}%</td>
        <td style="padding:10px 12px;text-align:center">
          <span style="background:${cor};color:#fff;padding:3px 10px;border-radius:99px;font-size:12px;font-weight:700">${m.eficiencia}%</span>
        </td>
      </tr>`;
  }).join('');

  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Arial,sans-serif">
  <div style="max-width:680px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#1e293b,#334155);padding:28px 32px">
      <div style="display:flex;align-items:center;gap:12px">
        <span style="font-size:28px">⛽</span>
        <div>
          <div style="color:#fff;font-size:20px;font-weight:700">FuelTracker Pro</div>
          <div style="color:#94a3b8;font-size:13px">Relatório de Eficiência — ${mes}</div>
        </div>
      </div>
    </div>

    <!-- Alerta -->
    <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:16px 32px;display:flex;align-items:center;gap:10px">
      <span style="font-size:20px">⚠️</span>
      <div>
        <div style="font-weight:700;color:#92400e">${maquinas.length} máquina${maquinas.length>1?'s':''} da operação <strong>${nomeGrupo}</strong> abaixo de ${limite}% de eficiência</div>
        <div style="font-size:13px;color:#b45309;margin-top:2px">Período analisado: últimos ${diasJanela} dias</div>
      </div>
    </div>

    <!-- Tabela -->
    <div style="padding:24px 32px">
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:#f8fafc">
            <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px">Máquina</th>
            <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px">Operação</th>
            <th style="padding:10px 12px;text-align:center;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px">Meta</th>
            <th style="padding:10px 12px;text-align:center;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px">Real</th>
            <th style="padding:10px 12px;text-align:center;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px">Desvio</th>
            <th style="padding:10px 12px;text-align:center;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px">Eficiência</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>

    <!-- Footer -->
    <div style="padding:20px 32px;background:#f8fafc;border-top:1px solid #e5e7eb;text-align:center">
      <a href="https://eulernasc.github.io/fueltracker" style="display:inline-block;background:#3b82f6;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">
        Abrir FuelTracker Pro →
      </a>
      <div style="margin-top:12px;font-size:12px;color:#9ca3af">
        Este e-mail foi gerado automaticamente todo dia 15 pelo FuelTracker Pro
      </div>
    </div>

  </div>
</body>
</html>`;
}

// ── Executa ───────────────────────────────────────────────────
gerarRelatorio().catch(err => {
  console.error('❌ Erro fatal:', err);
  process.exit(1);
});
