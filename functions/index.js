const { onDocumentWritten, onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// Günstige, für 2 Nutzer völlig ausreichende Region (Frankfurt, EU).
setGlobalOptions({ region: "europe-west3", maxInstances: 3 });

const STREAK_MEILENSTEINE = [7, 14, 30, 50, 100, 200, 365];
const NAME = { leon: "Leon", lotta: "Lotta" };

// ---------------------------------------------------------------------------
// Hilfsfunktion: Push an einen Nutzer (leon/lotta) schicken.
// Entfernt automatisch Tokens, die nicht mehr gültig sind (z.B. altes Handy).
//
// Wir schicken "notification" (Titel/Text) UND "data" (Zusatzinfos).
// Die Anzeige übernimmt der Browser automatisch anhand von "notification" -
// wir rufen selbst KEIN showNotification() mehr im Service Worker auf, damit
// nichts doppelt angezeigt wird und nichts durch einen eigenen Anzeige-Fehler
// leer/verloren gehen kann.
// ---------------------------------------------------------------------------
async function sendeAnNutzer(nutzer, titel, body, extraData) {
  var tokenDoc = await db.collection("push_tokens").doc(nutzer).get();
  if (!tokenDoc.exists) return;
  var tokens = tokenDoc.data().tokens || [];
  if (tokens.length === 0) return;

  var nachricht = {
    tokens: tokens,
    notification: { title: titel, body: body },
    data: extraData || {},
    webpush: {
      notification: { icon: "/icon.svg" },
      fcmOptions: { link: "/" }
    }
  };

  var antwort = await admin.messaging().sendEachForMulticast(nachricht);

  var ungueltigeTokens = [];
  antwort.responses.forEach(function (res, i) {
    if (!res.success) {
      var code = res.error && res.error.code;
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
        ungueltigeTokens.push(tokens[i]);
      }
    }
  });
  if (ungueltigeTokens.length > 0) {
    var verbleibend = tokens.filter(function (t) { return ungueltigeTokens.indexOf(t) === -1; });
    await tokenDoc.ref.set({ tokens: verbleibend }, { merge: true });
  }
}

// ---------------------------------------------------------------------------
// Streak am angegebenen Datum berechnen (gleiche Logik wie im Client).
// ---------------------------------------------------------------------------
async function berechneStreakAm(datumSchluessel) {
  var snapshot = await db.collection("abstimmung").get();
  var vollstaendigeDaten = new Set();
  snapshot.forEach(function (docSnap) {
    var d = docSnap.data();
    if (d.leon && d.lotta) { vollstaendigeDaten.add(docSnap.id); }
  });

  var pruefDatum = new Date(datumSchluessel + "T00:00:00Z");
  var streak = 0;
  while (vollstaendigeDaten.has(pruefDatum.toISOString().substring(0, 10))) {
    streak++;
    pruefDatum.setUTCDate(pruefDatum.getUTCDate() - 1);
  }
  return streak;
}

// ---------------------------------------------------------------------------
// Trigger 1: Abstimmung geändert -> "X hat abgestimmt" / Ergebnis / Meilenstein
// ---------------------------------------------------------------------------
exports.beiAbstimmungBenachrichtigen = onDocumentWritten("abstimmung/{datum}", async function (event) {
  var vorher = event.data.before.exists ? event.data.before.data() : {};
  var nachher = event.data.after.exists ? event.data.after.data() : {};
  var datum = event.params.datum;

  var leonVorher = !!vorher.leon, lottaVorher = !!vorher.lotta;
  var leonNachher = !!nachher.leon, lottaNachher = !!nachher.lotta;

  // Fall A: Beide haben gerade erst fertig abgestimmt -> Ergebnis an beide.
  var geradeFertig = leonNachher && lottaNachher && !(leonVorher && lottaVorher);
  if (geradeFertig) {
    var einig = nachher.leon === nachher.lotta;
    var ergebnisText = einig
      ? "Ihr seid euch einig! 🎉 (" + nachher.leon + ")"
      : "Uneinigkeit heute 😄 Leon: " + nachher.leon + ", Lotta: " + nachher.lotta;

    await Promise.all([
      sendeAnNutzer("leon", "Ergebnis der heutigen Frage", ergebnisText, { typ: "abstimmung_ergebnis" }),
      sendeAnNutzer("lotta", "Ergebnis der heutigen Frage", ergebnisText, { typ: "abstimmung_ergebnis" })
    ]);

    var streak = await berechneStreakAm(datum);
    if (STREAK_MEILENSTEINE.indexOf(streak) !== -1) {
      var meilensteinText = "🔥 " + streak + " Tage in Folge abgestimmt! Weiter so!";
      await Promise.all([
        sendeAnNutzer("leon", "Streak-Meilenstein!", meilensteinText, { typ: "streak_meilenstein" }),
        sendeAnNutzer("lotta", "Streak-Meilenstein!", meilensteinText, { typ: "streak_meilenstein" })
      ]);
    }
    return;
  }

  // Fall B: Nur eine Person hat gerade abgestimmt -> Partner benachrichtigen.
  if (leonNachher && !leonVorher && !lottaNachher) {
    await sendeAnNutzer("lotta", "Leon hat abgestimmt", "Leon hat bei der heutigen Frage abgestimmt. Du bist dran!", { typ: "partner_abgestimmt" });
  } else if (lottaNachher && !lottaVorher && !leonNachher) {
    await sendeAnNutzer("leon", "Lotta hat abgestimmt", "Lotta hat bei der heutigen Frage abgestimmt. Du bist dran!", { typ: "partner_abgestimmt" });
  }
});

// ---------------------------------------------------------------------------
// Trigger 2: Neue Brief-Fach-Nachricht -> Partner benachrichtigen.
// ---------------------------------------------------------------------------
exports.beiNeuerNachrichtBenachrichtigen = onDocumentCreated("briefe/{briefId}", async function (event) {
  var daten = event.data.data();
  var absender = daten.von;
  var empfaenger = absender === "leon" ? "lotta" : "leon";
  var absenderName = NAME[absender] || absender;

  var vorschau = (daten.text || "").length > 80 ? daten.text.substring(0, 77) + "..." : (daten.text || "");
  await sendeAnNutzer(empfaenger, "Neue Nachricht von " + absenderName, vorschau, { typ: "neue_nachricht" });
});




// ============================================================================
// EINMALIGE MIGRATION: alte Apps-Script-Daten (Abstimmungen, Chat, Denk-an-dich)
// nach Firestore übertragen. Überschreibt NIEMALS bereits vorhandene Werte,
// füllt nur Lücken auf bzw. addiert Zähler. Kann nach dem Umzug wieder
// entfernt werden (Datei diesen Abschnitt löschen + neu deployen).
// ============================================================================
const ALTE_DATEN = {
  "abstimmungen": {"2026-08-23":{"frage":"Wer räumt zuerst den Geschirrspüler ein?","leon":"Lotta","lotta":"Leon"},"2026-08-22":{"frage":"Wer trödelt öfter beim Rausgehen?","leon":"Lotta","lotta":"Lotta"},"2026-08-21":{"frage":"Wer kann besser mit Kritik umgehen?","leon":"Lotta","lotta":"Leon"},"2026-08-20":{"frage":"Wer isst öfter zu spät?","leon":"Lotta","lotta":"Lotta"},"2026-08-27":{"frage":"Wer würde eher ein Haustier anschaffen, ohne zu fragen?","leon":"Lotta","lotta":"Lotta"},"2026-08-26":{"frage":"Wer schaut öfter Serien ohne den anderen weiter?","leon":"Lotta","lotta":"Lotta"},"2026-08-25":{"frage":"Wer bringt öfter Süßigkeiten mit?","leon":"Lotta","lotta":"Lotta"},"2026-08-24":{"frage":"Wer hat mehr offene Browser-Tabs?","leon":"Leon","lotta":"Leon"},"2026-08-12":{"frage":"Wer würde eher spontan verreisen?","leon":"Lotta","lotta":"Lotta"},"2026-08-11":{"frage":"Wer kann Ikea-Möbel besser aufbauen?","leon":"Lotta","lotta":"Lotta"},"2026-08-10":{"frage":"Wer ist der bessere Multitasker?","leon":"Leon","lotta":"Leon"},"2026-08-16":{"frage":"Wer ist der bessere Planer?","leon":"Leon","lotta":"Lotta"},"2026-08-15":{"frage":"Wer trinkt mehr Kaffee?","leon":"Leon","lotta":"Leon"},"2026-08-14":{"frage":"Wer verlegt öfter den Schlüssel?","leon":"Leon","lotta":"Lotta"},"2026-08-13":{"frage":"Wer hat mehr Geduld im Stau?","leon":"Lotta","lotta":"Lotta"},"2026-08-19":{"frage":"Wer hat den volleren Terminkalender?","leon":"Leon","lotta":"Lotta"},"2026-08-18":{"frage":"Wer kann besser Wegbeschreibungen erklären?","leon":"Lotta","lotta":"Lotta"},"2026-08-17":{"frage":"Wer telefoniert lieber statt zu schreiben?","leon":"Leon","lotta":"Leon"}},
  "briefe": {"brief_20260818065414_933":{"von":"Lotta","text":"Du hast ja noch mehr verändert 🥰","datum":"18.08.2026","uhrzeit":"06:54"},"brief_20260819072653_96":{"von":"Leon","text":"Hab immer Lust noch mehr coole Sachen zu bauen🥰","datum":"19.08.2026","uhrzeit":"07:26"},"brief_20260814144602_551":{"von":"Leon","text":"Jaaa, aber ich such auch immer wie blöde meine Sachen, so wie mein Brillenetui immer haha","datum":"14.08.2026","uhrzeit":"14:46"},"brief_20260811181311_183":{"von":"Lotta","text":"Hallo mein zauberhafter Kacki <3","datum":"11.08.2026","uhrzeit":"18:13"},"brief_20260813073522_335":{"von":"Leon","text":"Einfach ein legendärer Song von dir🥰","datum":"13.08.2026","uhrzeit":"07:35"},"brief_20260811153426_624":{"von":"Leon","text":"Hallo Kacki <3","datum":"11.08.2026","uhrzeit":"15:34"},"brief_20260812085921_305":{"von":"Lotta","text":"Das ist richtig schön jeden Morgen ❤️","datum":"12.08.2026","uhrzeit":"08:59"},"brief_20260812090620_882":{"von":"Leon","text":"Ich mag das auch sehr❤️","datum":"12.08.2026","uhrzeit":"09:06"},"brief_20260820072430_766":{"von":"Lotta","text":"Gut dann haben wir es ja gleich verstanden 😂","datum":"20.08.2026","uhrzeit":"07:24"},"brief_20260812081303_856":{"von":"Leon","text":"Guten Morgen Schatz❤️","datum":"12.08.2026","uhrzeit":"08:13"},"brief_20260820071911_803":{"von":"Leon","text":"Die Frage ergibt keinen Sinn, ich glaube er meint ist😂","datum":"20.08.2026","uhrzeit":"07:19"},"brief_20260819072524_377":{"von":"Lotta","text":"Aww ist das toll! 🥰","datum":"19.08.2026","uhrzeit":"07:25"},"brief_20260820065250_147":{"von":"Lotta","text":"Die Frage checke ich nicht ganz 😂 isst oder ist?","datum":"20.08.2026","uhrzeit":"06:52"},"brief_20260813065328_323":{"von":"Lotta","text":"Winke winke macht leons Fuß❤️","datum":"13.08.2026","uhrzeit":"06:53"},"brief_20260814103535_535":{"von":"Lotta","text":"Ohhh das erste Mal nicht einig. Du passt doch immer so gut auf deinen Schlüssel auf 😂","datum":"14.08.2026","uhrzeit":"10:35"},"brief_20260814161810_425":{"von":"Lotta","text":"Jaa das stimmt 😂😂","datum":"14.08.2026","uhrzeit":"16:18"},"brief_20260818080345_901":{"von":"Leon","text":"Ja ich hatte lust noch ein paar Kleinigkeiten einzubauen🥰","datum":"18.08.2026","uhrzeit":"08:03"}},
  "gedankeLeon": 6,
  "gedankeLotta": 7
};

exports.migriereAlteDaten = onRequest(async (req, res) => {
  const SCHLUESSEL = "osna-migration-2026";
  if (req.query.schluessel !== SCHLUESSEL) {
    res.status(403).send("Falscher oder fehlender Schlüssel.");
    return;
  }

  const statusRef = db.collection("migration").doc("status");
  const statusSnap = await statusRef.get();
  if (statusSnap.exists && statusSnap.data().erledigt) {
    res.status(200).send(
      "Migration wurde bereits am " + statusSnap.data().zeitpunkt +
      " durchgeführt. Es wurde nichts verändert (Sicherheitsschutz gegen Doppelausführung)."
    );
    return;
  }

  var abstimmungNeu = 0;
  var abstimmungErgaenzt = 0;

  for (const [datum, eintrag] of Object.entries(ALTE_DATEN.abstimmungen)) {
    const ref = db.collection("abstimmung").doc(datum);
    const snap = await ref.get();
    const bestehend = snap.exists ? snap.data() : {};
    const merged = {
      frage: bestehend.frage || eintrag.frage,
      leon: bestehend.leon || eintrag.leon,
      lotta: bestehend.lotta || eintrag.lotta
    };
    await ref.set(merged, { merge: true });
    if (snap.exists) { abstimmungErgaenzt++; } else { abstimmungNeu++; }
  }

  var briefeImportiert = 0;
  for (const [key, eintrag] of Object.entries(ALTE_DATEN.briefe)) {
    const zeitTeil = key.split("_")[1]; // Format: yyyyMMddHHmmss
    const jahr = Number(zeitTeil.substring(0, 4));
    const monat = Number(zeitTeil.substring(4, 6));
    const tag = Number(zeitTeil.substring(6, 8));
    const stunde = Number(zeitTeil.substring(8, 10));
    const minute = Number(zeitTeil.substring(10, 12));
    const sekunde = Number(zeitTeil.substring(12, 14));
    // Europe/Berlin ist im August Sommerzeit (UTC+2) - alle Daten liegen im August.
    const zeitstempel = Date.UTC(jahr, monat - 1, tag, stunde - 2, minute, sekunde);

    const neuerRef = db.collection("briefe").doc("migriert_" + key);
    await neuerRef.set({
      von: eintrag.von === "Leon" ? "leon" : "lotta",
      text: eintrag.text,
      zeitstempel: zeitstempel
    }, { merge: true });
    briefeImportiert++;
  }

  // Additiv erhöhen statt überschreiben, damit Klicks aus der Testphase der neuen App erhalten bleiben.
  const gLeonRef = db.collection("einstellungen").doc("gedankeAnzahl_leon");
  const gLottaRef = db.collection("einstellungen").doc("gedankeAnzahl_lotta");
  await gLeonRef.set({ anzahl: admin.firestore.FieldValue.increment(ALTE_DATEN.gedankeLeon) }, { merge: true });
  await gLottaRef.set({ anzahl: admin.firestore.FieldValue.increment(ALTE_DATEN.gedankeLotta) }, { merge: true });

  await statusRef.set({ erledigt: true, zeitpunkt: new Date().toISOString() });

  res.status(200).send(
    "Migration abgeschlossen!\n\n" +
    "Abstimmungstage neu angelegt: " + abstimmungNeu + "\n" +
    "Abstimmungstage ergänzt (Tag existierte schon): " + abstimmungErgaenzt + "\n" +
    "Brief-Fach-Nachrichten importiert: " + briefeImportiert + "\n" +
    "Denk-an-dich-Zähler erhöht: +" + ALTE_DATEN.gedankeLeon + " (Leon), +" + ALTE_DATEN.gedankeLotta + " (Lotta)"
  );
});


// ============================================================================
// EINMALIGE AUFRÄUM-FUNKTION: löscht Leons letzte 2 "Test"-Nachrichten im
// Brief-Fach. Kann nach Gebrauch wieder aus der Datei entfernt werden.
// ============================================================================
exports.loescheTestNachrichten = onRequest(async (req, res) => {
  const SCHLUESSEL = "osna-cleanup-2026";
  if (req.query.schluessel !== SCHLUESSEL) {
    res.status(403).send("Falscher oder fehlender Schlüssel.");
    return;
  }

  const snapshot = await db.collection("briefe")
    .where("von", "==", "leon")
    .where("text", "==", "Test")
    .get();

  var kandidaten = snapshot.docs.slice();
  kandidaten.sort(function (a, b) { return b.data().zeitstempel - a.data().zeitstempel; });
  kandidaten = kandidaten.slice(0, 2);

  var geloescht = 0;
  for (const doc of kandidaten) {
    await doc.ref.delete();
    geloescht++;
  }

  res.status(200).send("Gelöscht: " + geloescht + " Nachricht(en) mit Text 'Test' von Leon.");
});
