package cloud.clever.observatory;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.validation.ConstraintViolation;
import jakarta.validation.Validation;
import jakarta.validation.Validator;
import java.util.Locale;
import java.util.Set;
import java.util.stream.Collectors;
import org.bson.Document;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.http.converter.json.Jackson2ObjectMapperBuilder;

class DiscoveryTest {

    private static final ObjectMapper JSON = Jackson2ObjectMapperBuilder.json().build();
    private static Validator validator;

    @BeforeAll
    static void setUp() {
        Locale.setDefault(Locale.ENGLISH);
        validator = Validation.buildDefaultValidatorFactory().getValidator();
    }

    private static Discovery read(String json) throws Exception {
        return JSON.readValue(json, Discovery.class);
    }

    private static Set<String> invalidFields(Discovery discovery) {
        return validator.validate(discovery).stream()
                .map(ConstraintViolation::getPropertyPath)
                .map(Object::toString)
                .collect(Collectors.toSet());
    }

    @Test
    void theTypeFieldPicksTheRecord() throws Exception {
        assertThat(read("{\"type\":\"comet\",\"name\":\"X\"}")).isInstanceOf(Discovery.Comet.class);
        assertThat(read("{\"type\":\"planet\",\"name\":\"X\"}")).isInstanceOf(Discovery.Planet.class);
    }

    @Test
    void aValidStarBecomesAStarDocument() throws Exception {
        Discovery star = read("""
                {"type":"star","name":"Lumen","magnitude":3.2,"spectralClass":"G2 V",
                 "distanceLy":120,"ra":6.5,"dec":-10,"observer":"Ada"}""");
        assertThat(invalidFields(star)).isEmpty();

        Document doc = star.toDocument();
        assertThat(doc.getString("type")).isEqualTo("star");
        assertThat(doc.getDouble("magnitude")).isEqualTo(3.2);
        assertThat(doc.get("discovery", Document.class).getString("by")).isEqualTo("Ada");
    }

    @Test
    void eachTypeHasItsOwnRules() throws Exception {
        Discovery star = read("""
                {"type":"star","name":"<script>","magnitude":40,"spectralClass":"Z9","ra":30,"dec":0}""");
        assertThat(invalidFields(star)).contains("name", "magnitude", "spectralClass", "distanceLy", "ra");

        Discovery comet = read("""
                {"type":"comet","name":"Comet Ada","orbitalPeriodYears":-3,"lastPerihelion":"2999-01-01"}""");
        assertThat(invalidFields(comet)).containsExactlyInAnyOrder("orbitalPeriodYears", "lastPerihelion");
    }

    @Test
    void aNebulaGetsNestedSexagesimalCoordinates() throws Exception {
        Document doc = read("""
                {"type":"nebula","name":"Veil","nebulaType":"emission","ra":20.75,"dec":-0.5}""").toDocument();
        Document coordinates = doc.get("coordinates", Document.class);

        assertThat(coordinates.get("ra", Document.class)).isEqualTo(new Document("h", 20).append("m", 45.0));
        Document dec = coordinates.get("dec", Document.class);
        assertThat(1 / dec.getDouble("d")).isNegative(); // -0.0: half a degree south
        assertThat(dec.getInteger("m")).isEqualTo(30);
    }

    @Test
    void aPlanetStoresMoonsAsSubDocuments() throws Exception {
        Document doc = read("""
                {"type":"planet","name":"Vulcan","moons":["Amok"],"rings":true,"ra":1,"dec":2}""").toDocument();
        assertThat(doc.getList("moons", Document.class)).containsExactly(new Document("name", "Amok"));
        assertThat(doc.getBoolean("rings")).isTrue();
    }
}
