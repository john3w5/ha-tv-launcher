# Volitelná integrace oznámení z Home Assistant

`home_tv.yaml` obsahuje pouze generické REST příkazy pro oznámení a média. Nemá žádné automatizace, skutečné entity, adresy domácnosti nebo přihlašovací údaje. Nic se automaticky neinstaluje ani neaktivuje.

Definice začleňte do svého spravovaného HA YAML podle způsobu instalace, doplňte vlastní hodnoty ze `secrets.example.yaml` do soukromého `secrets.yaml`, zkontrolujte konfiguraci a načtěte ji postupem své verze HA. Použijte samostatný `webhook_token` nastavený v aplikaci; nepoužívejte HA přístupový token.

```yaml
action: rest_command.home_tv_notify
data:
  title: "Home TV"
  message: "Ukázkové oznámení"
  notification_type: info
  duration_seconds: 12
```

```yaml
action: rest_command.home_tv_media
data:
  title: "Moje video"
  media_url: "/media/my-video.mp4"
  media_type: "video/mp4"
```

Odpověď HTTP 202 potvrzuje přijetí serverem, nikoli zobrazení na TV nebo přehrání média. Vlastní soubor musí být v povolené lokální složce nebo na výslovně povoleném hostiteli. Automatizace vytvářejte nad vlastními skutečnými entitami a ověřeným průběhem událostí.
