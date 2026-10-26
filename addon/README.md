# Home TV Launcher pro Home Assistant

Aplikace provozuje Node bridge vedle HA Core. TV se připojuje přímo k její vlastní LAN adrese na portu 4317; pro běžný provoz není potřeba vývojový počítač. Každá instalace má vlastní konfiguraci, párování, profil i fotografie. V repozitáři nejsou přihlašovací údaje ani mapování konkrétní domácnosti.

## Instalace

V HA OS přidejte repozitář `https://github.com/michalschoniger-ops/home-tv-launcher` do obchodu aplikací a instalujte **Home TV Launcher**. Hotový instalační adresář je `addon/`; tento zdrojový adresář `ha-app/` má šablonu `app-config.yaml`, aby jej Supervisor nepovažoval za druhou aplikaci.

Při vývoji nebo ruční lokální instalaci vytvořte nový build kontext z kořene repozitáře:

```sh
node ha-app/prepare-package.mjs /absolute/new/home-tv-launcher
```

Výstup má vlastní `config.yaml`, Dockerfile, runtime a manifest SHA-256. Packager kopíruje jen vybrané zdroje; osobní `.env`, `config.json`, `private/` ani fotografie se do obrazu nepřenášejí. Cílový adresář musí být nový. Instalujte jej běžným postupem pro lokální aplikaci HA OS. Ruční a GitHub instalace používají stejný slug `home_tv_launcher`.

## První spuštění

1. Nastavte `public_origin` na skutečnou adresu hostitele dostupnou z TV, například změňte výchozí hostname podle své sítě. TV APK musí mít stejný dashboard origin a povolený host.
2. Výchozí `ha_connection: supervisor` použije interní REST i WebSocket a token předaný Supervisorem. Pro `direct` vyplňte vlastní `ha_url` a `ha_access_token` v soukromých volbách aplikace.
3. Zadejte vlastní dlouhý náhodný `pairing_code`, který pak zadáte v TV, a jiný náhodný `webhook_token`, pokud chcete posílat oznámení. Při vynechání se hodnoty vytvoří náhodně v privátním `/data`, nezobrazují se v logu. Pro běžné párování pak nastavte známý vlastní kód ve volbách a restartujte aplikaci.
4. První start vytvoří `/data/config.json` z generického `config.example.json`. Entity `example_*` jsou pouze zástupné názvy: nahradíte je vlastními skutečnými entitami. Neznámé zdroje se nemění na falešné živé hodnoty.

## Vlastní mapování a aktualizace

Zkopírujte generický `config.example.json`, upravte jen pro svou instalaci a vložte jej jako `config.json` do vlastní konfigurační složky aplikace (uvnitř kontejneru `/config/config.json`). V HA OS je to vlastní složka aplikace v `addon_configs`, nikoli veřejný adresář webového serveru. JSON neobsahuje žádné HA tokeny nebo hesla; ty patří do soukromých voleb aplikace.

Nastavte `config_import_revision: 1` a restartujte aplikaci. Při další záměrné změně souboru číslo zvyšte na 2, 3 atd. Pouze vyšší revize požádá o nový import. Před importem se nový JSON zkontroluje; původní konfigurace se uchová v privátní záloze `/data/config-before-import-N.json`, nový soubor se uloží atomicky a vznikne privátní importní marker. Přerušený import lze se stejným souborem/revizí bezpečně zopakovat; neočekávanou mezilehlou změnu konfigurace aplikace odmítne přepsat.

Běžné restarty a aktualizace nemění osobní `/data/config.json`, relace, vytvořené tajné hodnoty, profil ani fotografie. Přepisuje se pouze dodaný kód a veřejné assety. Aktualizace nevytváří nové párování a nemá zabudované migrace žádné domácnosti. Osobní konfigurační soubor ani soukromé zálohy nikdy neposílejte do veřejného repozitáře.

`night_control_enabled` zůstává výchozí vypnuté. Aplikace si nežádá Docker socket, host networking ani správu Supervisoru. TCP watchdog kontroluje pouze běžící server, nepotvrzuje dostupnost HA, kamery nebo fyzické TV. Přímý HTTP port používejte v důvěryhodné LAN; nepřesměrovávejte jej na veřejný internet. WebRTC/HLS a skutečné TV ovládání ověřte pro vlastní zařízení a zdroje.
