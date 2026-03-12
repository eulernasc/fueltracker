// ============================================================
//  FuelTracker Pro — Relatório Mensal Automático de Eficiência
//  Envio via Gmail SMTP (nodemailer)
// ============================================================

import nodemailer from 'nodemailer';

const GRUPOS = [
  {
    nome: 'CENIBRA',
    operacoes: ['CENIBRA COCAIS/RIO DOCE','CENIBRA NOVA ERA','CENIBRA SANTA BARBARA'],
    destinatarios: ['eulernascimento@expressonepomuceno.com.br'],
  },
  {
    nome: 'CMPC FLORESTAL',
    operacoes: ['CMPC FLORESTAL'],
    destinatarios: ['eulernascimento@expressonepomuceno.com.br'],
  },
  {
    nome: 'SUZANO ARACRUZ',
    operacoes: ['SUZANO ARACRUZ'],
    destinatarios: ['eulernascimento@expressonepomuceno.com.br'],
  },
  {
    nome: 'SUZANO RIBAS',
    operacoes: ['SUZANO RIBAS'],
    destinatarios: ['eulernascimento@expressonepomuceno.com.br'],
  },
];

const LIMITE_EFICIENCIA = 98;
const DIAS_JANELA = 15;

// ── Busca o documento único do Firebase ──────────────────────
async function carregarDados() {
  const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
  const API_KEY = process.env.FIREBASE_API_KEY;

  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/fueltracker/dados?key=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Firestore error: ${res.status} ${await res.text()}`);
  const doc = await res.json();

  if (!doc.fields) throw new Error('Documento "fueltracker/dados" não encontrado ou vazio');

  function parseValue(v) {
    if (!v) return null;
    if (v.stringValue !== undefined) return v.stringValue;
    if (v.integerValue !== undefined) return parseFloat(v.integerValue);
    if (v.doubleValue !== undefined) return parseFloat(v.doubleValue);
    if (v.booleanValue !== undefined) return v.booleanValue;
    if (v.nullValue !== undefined) return null;
    if (v.arrayValue) return (v.arrayValue.values || []).map(parseValue);
    if (v.mapValue) {
      const obj = {};
      for (const [k, val] of Object.entries(v.mapValue.fields || {})) obj[k] = parseValue(val);
      return obj;
    }
    return null;
  }

  const state = {};
  for (const [k, v] of Object.entries(doc.fields)) state[k] = parseValue(v);
  return state;
}

// ── Lógica principal ──────────────────────────────────────────
async function gerarRelatorio() {
  console.log('📊 Iniciando relatório...');

  const state = await carregarDados();
  const abastecimentos = state.abastecimentos || [];
  const maquinas = state.maquinas || [];
  console.log(`✅ ${abastecimentos.length} abastecimentos, ${maquinas.length} máquinas carregados`);

  const maqMap = {};
  maquinas.forEach(m => { if (m && m.placa) maqMap[m.placa] = m; });

  const dataCorte = new Date();
  dataCorte.setDate(dataCorte.getDate() - DIAS_JANELA);
  const dataCorteStr = dataCorte.toISOString().split('T')[0];
  const recentes = abastecimentos.filter(a => a && a.data && a.data >= dataCorteStr);
  console.log(`📅 ${recentes.length} registros nos últimos ${DIAS_JANELA} dias`);

  const byMaq = {};
  recentes.forEach(a => {
    if (!a || !a.placa) return;
    if (!byMaq[a.placa]) byMaq[a.placa] = { litros: 0, horas: 0 };
    byMaq[a.placa].litros += parseFloat(a.litros) || 0;
    byMaq[a.placa].horas += parseFloat(a.horas) || 0;
  });

  const maquinasComProblema = [];
  for (const [placa, dados] of Object.entries(byMaq)) {
    const maq = maqMap[placa];
    if (!maq || !maq.meta || parseFloat(maq.meta) <= 0 || dados.horas <= 0) continue;
    const mediaReal = dados.litros / dados.horas;
    const meta = parseFloat(maq.meta);
    const eficiencia = (meta / mediaReal) * 100;
    if (eficiencia < LIMITE_EFICIENCIA) {
      maquinasComProblema.push({
        placa,
        operacao: (maq.operacao || 'Sem Operação').replace(/_/g, ' '),
        mediaReal: mediaReal.toFixed(2),
        meta: meta.toFixed(1),
        eficiencia: eficiencia.toFixed(1),
        desvio: ((mediaReal - meta) / meta * 100).toFixed(1),
      });
    }
  }

  console.log(`⚠️  ${maquinasComProblema.length} máquinas abaixo de ${LIMITE_EFICIENCIA}%`);

  if (maquinasComProblema.length === 0) {
    console.log('✅ Todas dentro do limite — nenhum e-mail enviado');
    return;
  }

  // Configura Gmail SMTP
  const transporter = nodemailer.createTransport({
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
    auth: {
      user: process.env.OUTLOOK_USER,
      pass: process.env.OUTLOOK_PASS,
    },
    tls: { ciphers: 'SSLv3' },
  });

  const mes = new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

  for (const grupo of GRUPOS) {
    const maqsDoGrupo = maquinasComProblema
      .filter(m => grupo.operacoes.some(op =>
        m.operacao.toUpperCase().includes(op.toUpperCase()) ||
        op.toUpperCase().includes(m.operacao.toUpperCase())
      ))
      .sort((a, b) => parseFloat(a.eficiencia) - parseFloat(b.eficiencia));

    if (maqsDoGrupo.length === 0) {
      console.log(`✅ ${grupo.nome} — dentro do limite`);
      continue;
    }

    const html = gerarHTML(grupo.nome, maqsDoGrupo, mes);
    try {
      await transporter.sendMail({
        from: `FuelTracker Pro <${process.env.OUTLOOK_USER}>`,
        to: grupo.destinatarios.join(', '),
        subject: `⚠️ FuelTracker — Alerta de Eficiência ${grupo.nome} · ${mes}`,
        html,
      });
      console.log(`📧 Enviado: ${grupo.nome} → ${grupo.destinatarios.join(', ')}`);
    } catch (err) {
      console.error(`❌ Erro ${grupo.nome}:`, err.message);
    }
  }
  console.log('🏁 Concluído');
}

// ── Template HTML ─────────────────────────────────────────────
function gerarHTML(nomeGrupo, maquinas, mes) {
  const linhas = maquinas.map(m => {
    const cor = parseFloat(m.eficiencia) < 90 ? '#ef4444' :
                parseFloat(m.eficiencia) < 95 ? '#f97316' : '#f59e0b';
    return `<tr style="border-bottom:1px solid #e5e7eb">
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

  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Arial,sans-serif">
  <div style="max-width:680px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#1e293b,#334155);padding:28px 32px">
      <span style="font-size:28px">⛽</span>
      <span style="color:#fff;font-size:20px;font-weight:700;margin-left:12px">FuelTracker Pro</span>
      <div style="color:#94a3b8;font-size:13px;margin-top:4px">Relatório de Eficiência — ${mes}</div>
    </div>
    <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:16px 32px">
      <div style="font-weight:700;color:#92400e">⚠️ ${maquinas.length} máquina${maquinas.length>1?'s':''} da operação <strong>${nomeGrupo}</strong> abaixo de ${LIMITE_EFICIENCIA}% de eficiência</div>
      <div style="font-size:13px;color:#b45309;margin-top:4px">Período: últimos ${DIAS_JANELA} dias</div>
    </div>
    <div style="padding:24px 32px">
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="background:#f8fafc">
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">Máquina</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">Operação</th>
          <th style="padding:10px 12px;text-align:center;font-size:11px;color:#6b7280;text-transform:uppercase">Meta</th>
          <th style="padding:10px 12px;text-align:center;font-size:11px;color:#6b7280;text-transform:uppercase">Real</th>
          <th style="padding:10px 12px;text-align:center;font-size:11px;color:#6b7280;text-transform:uppercase">Desvio</th>
          <th style="padding:10px 12px;text-align:center;font-size:11px;color:#6b7280;text-transform:uppercase">Eficiência</th>
        </tr></thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>
    <div style="padding:20px 32px;background:#f8fafc;border-top:1px solid #e5e7eb;text-align:center">
      <a href="https://eulernasc.github.io/fueltracker" style="display:inline-block;background:#3b82f6;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Abrir FuelTracker Pro →</a>
      <div style="margin-top:12px;font-size:12px;color:#9ca3af">Gerado automaticamente todo dia 15 pelo FuelTracker Pro</div>
    </div>
  </div>
</body></html>`;
}

gerarRelatorio().catch(err => { console.error('❌ Erro fatal:', err); process.exit(1); });
