"use client";

import type { CharacterFormValues } from "./CharacterForm";
import { GROUP_FIELD_LIMITS, MAX_GROUP_PARTICIPANTS, RP_FIELD_LIMITS, type GroupParticipant } from "@/lib/roleplayConfig";
import RoleplayModeCards from "@/components/RoleplayModeCards";
import { CHARACTER_LIMITS } from "@/lib/characterFields";

type Props = {
  values: CharacterFormValues;
  onChange: <K extends keyof CharacterFormValues>(field: K, value: CharacterFormValues[K]) => void;
  nameError?: string;
  onClearNameError: () => void;
  showModePicker?: boolean;
};
const inputClass = "w-full rounded-lg border border-[#2A2A2A] bg-[#0A0A0A] p-3 text-base text-white outline-none focus:border-[#6C63FF]";
function TextField({ id, label, value, onChange, maxLength, hint, required = false, rows = 4 }: {
  id: string; label: string; value: string; onChange: (value: string) => void;
  maxLength: number; hint: string; required?: boolean; rows?: number;
}) {
  return <div className="space-y-2">
    <label htmlFor={id} className="block text-base font-semibold text-white">{label} {required ? <span className="text-[#A0A0A0]">*</span> : <span className="text-sm font-normal text-[#A0A0A0]">— необязательно</span>}</label>
    <textarea id={id} className={inputClass} value={value} onChange={event => onChange(event.target.value)} maxLength={maxLength} required={required} rows={rows} />
    <p className="text-sm leading-relaxed text-[#A0A0A0]">{hint} <span>{value.length}/{maxLength}</span></p>
  </div>;
}
function GroupMembers({ values, onChange }: Pick<Props, "values" | "onChange">) {
  const participants = values.rpConfig.participants ?? [];
  const setMembers = (members: GroupParticipant[]) => onChange("rpConfig", { ...values.rpConfig, participants: members });
  const update = (id: string, field: keyof typeof GROUP_FIELD_LIMITS, text: string) => setMembers(participants.map(member => member.id === id ? { ...member, [field]: text } : member));
  return <section className="space-y-4" aria-label="Участники истории">
    <div><h2 className="text-lg font-bold">Персонажи истории · {participants.length}/{MAX_GROUP_PARTICIPANTS}</h2>
      <p className="mt-1 text-sm text-[#A0A0A0]">Начните с одного и добавляйте остальных позже. Выбранная модель играет весь состав; ваш герой остаётся под вашим управлением.</p></div>
    {participants.map((member, index) => <details key={member.id} open={index === participants.length - 1} onInvalidCapture={event => { event.currentTarget.open = true; }} className="rounded-xl border border-[#2A2A2A] bg-[#121212] p-4">
      <summary className="cursor-pointer font-semibold">{member.name || `Персонаж ${index + 1}`}</summary>
      <div className="mt-4 space-y-4">
        <label className="block space-y-2"><span className="font-semibold">Имя *</span><input className={inputClass} aria-label={`Имя персонажа ${index + 1}`} required maxLength={GROUP_FIELD_LIMITS.name} value={member.name} onChange={event => update(member.id, "name", event.target.value)} /></label>
        <TextField id={`member-${member.id}-description`} label="Характер и история" required maxLength={GROUP_FIELD_LIMITS.description} value={member.description} onChange={text => update(member.id, "description", text)} hint="Личность, цели и исходные связи с другими героями." />
        <TextField id={`member-${member.id}-appearance`} label="Внешность" maxLength={GROUP_FIELD_LIMITS.appearance} value={member.appearance} onChange={text => update(member.id, "appearance", text)} hint="Несколько узнаваемых черт." rows={2} />
        <TextField id={`member-${member.id}-speechStyle`} label="Манера общения" maxLength={GROUP_FIELD_LIMITS.speechStyle} value={member.speechStyle} onChange={text => update(member.id, "speechStyle", text)} hint="Например: короткие реплики, сухой юмор, официальное обращение." rows={2} />
        <button type="button" className="text-sm text-red-400 underline" onClick={() => {
          if (window.confirm(`Убрать ${member.name || "этого персонажа"} из состава? Сообщения истории останутся.`)) setMembers(participants.filter(item => item.id !== member.id));
        }}>Убрать персонажа</button>
      </div>
    </details>)}
    {!participants.length && <p className="text-sm text-[#A0A0A0]">Добавьте первого персонажа, чтобы сохранить групповую историю.</p>}
    <button type="button" className="wd-btn" disabled={participants.length >= MAX_GROUP_PARTICIPANTS} onClick={() => setMembers([...participants, { id: crypto.randomUUID(), name: "", description: "", appearance: "", speechStyle: "" }])}>Добавить персонажа</button>
    <p className="text-sm text-[#A0A0A0]">Все участники делят контекст выбранной модели. Добавление в состав не делает героя свидетелем прошлых событий.</p>
  </section>;
}
export default function RoleplayCardFields({ values, onChange, nameError, onClearNameError, showModePicker = true }: Props) {
  const single = values.roleplayMode === "character";
  const world = values.roleplayMode === "world";
  return <div className="space-y-6">
    {showModePicker && <fieldset><legend className="mb-3 text-lg font-semibold">Тип карточки</legend>
      <RoleplayModeCards selected={values.roleplayMode} onSelect={mode => onChange("roleplayMode", mode)} />
    </fieldset>}
    <p className="text-sm text-[#A0A0A0]">Поля со звёздочкой обязательны. Смена типа карточки сохраняет начатые истории и их выбранный режим.</p>
    {values.promptBuilderVersion === 1 && <p className="rounded-lg border border-[#6C63FF]/40 p-3 text-sm text-[#A0A0A0]">Карточка использует прежние инструкции. Для применения новых настроек сохраните поля и подключите новую сборку в разделе «Расширенные настройки».</p>}
    <div className="space-y-2"><label htmlFor="name" className="block text-base font-semibold">{single ? "Имя персонажа" : world ? "Название вселенной" : "Название истории"} *</label>
      <input id="name" className={inputClass} value={values.name} required onChange={event => { onChange("name", event.target.value); onClearNameError(); }} />
      {nameError && <p role="alert" className="text-sm text-red-400">{nameError}</p>}
    </div>
    <TextField id="descriptionCard" label="Краткое описание для каталога" value={values.descriptionCard} onChange={text => onChange("descriptionCard", text)} maxLength={CHARACTER_LIMITS.descriptionCard} hint="Публичный текст, который помогает выбрать вашу карточку." rows={2} />
    <TextField id="description" label={single ? "Характер и история" : world ? "Описание вселенной" : "Общая сцена и окружение"} value={values.description} onChange={text => onChange("description", text)} maxLength={CHARACTER_LIMITS.description} required={single || world} hint={single ? "Личность, поведение, цели и биография — одним текстом." : "Место, время, атмосфера и основные правила вашей истории."} rows={5} />
    {single && <TextField id="appearance" label="Внешность" value={values.appearance} onChange={text => onChange("appearance", text)} maxLength={CHARACTER_LIMITS.appearance} hint="Особенности внешности и одежды героя." />}
    {world && <TextField id="npcs" label="Действующие лица" value={values.rpConfig.npcs ?? ""} onChange={text => onChange("rpConfig", { ...values.rpConfig, npcs: text })} maxLength={RP_FIELD_LIMITS.npcs} hint="Основные NPC, их характеры и связи. Вы управляете своим героем самостоятельно." />}
    {values.roleplayMode === "group" && <GroupMembers values={values} onChange={onChange} />}
    <TextField id="scenario" label="Начальная ситуация" value={values.scenario} onChange={text => onChange("scenario", text)} maxLength={CHARACTER_LIMITS.scenario} hint="Где и как начинается общение. Это отправная точка, а не сценарий всех будущих ответов." />
    <TextField id="greeting" label={single ? "Первое сообщение персонажа" : "Первое сообщение ведущего"} value={values.greeting} onChange={text => onChange("greeting", text)} maxLength={CHARACTER_LIMITS.greeting} hint="Сообщение, которое пользователь увидит в начале нового чата." />
  </div>;
}
