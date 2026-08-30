const { onDocumentWritten, onDocumentCreated } = require("firebase-functions/v2/firestore");
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
